<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  AGENT_PERMISSION_MODE_LABELS,
  type AgentCommand,
  type AgentEnvironment,
  type AgentModel,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunMode,
} from '@shared/types';
import { api } from '../api';

/**
 * Point an agent at whatever is on screen.
 *
 * The same dialog drives both slash commands — `/plan-tasks` from an issue,
 * `/work-task` from a task — because the only thing that differs between them is
 * the command name and its argument, and both are installed in Claude Code and
 * `pi` alike.
 *
 * Two run modes, and they are not two settings of one thing. A **terminal** run
 * opens a real window with the agent interactive inside it: it can ask, you can
 * answer, and this dialog's job ends at launch. A **headless** run is `-p` with
 * nobody watching, so its output is captured and streamed back here instead.
 */
const props = defineProps<{
  command: AgentCommand;
  /** The command's one argument — `#677`, `T-12`, or empty for its default. */
  target: string;
  /** What the run is about, for the run history: `issue`, `task`, … */
  subjectKind: string;
  subjectRef: string;
  /** Shown under the heading so it is obvious what is about to be worked on. */
  subjectTitle: string;
}>();

const emit = defineEmits<{ close: [] }>();

const environment = ref<AgentEnvironment | null>(null);
const models = ref<AgentModel[]>([]);
const modelsLoading = ref(false);
const modelsError = ref<string | null>(null);

const harness = ref<string>('claude');
const model = ref('');
const mode = ref<AgentRunMode>('terminal');
const permissionMode = ref<AgentPermissionMode>('auto');
const extra = ref('');

const error = ref<string | null>(null);
const starting = ref(false);
const run = ref<AgentRunDetail | AgentRun | null>(null);
const output = ref('');
const history = ref<AgentRun[]>([]);

const LABEL: Record<AgentCommand, string> = {
  'plan-tasks': 'Investigate',
  'work-task': 'Work task',
};

const chosenHarness = computed(
  () => environment.value?.harnesses.find((one) => one.id === harness.value) ?? null,
);

/** The prompt as the server will assemble it. Shown so nothing is a surprise. */
const preview = computed(() => {
  const head = props.target ? `/${props.command} ${props.target}` : `/${props.command}`;
  return extra.value.trim() ? `${head}\n\n${extra.value.trim()}` : head;
});

/** Model options grouped by provider — pi lists several hundred across a dozen. */
const groupedModels = computed(() => {
  const groups = new Map<string, AgentModel[]>();
  for (const entry of models.value) {
    const key = entry.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()];
});

/** What each mode actually means, in the terms this app's two commands work in.
 *  Both are mostly shell (`tasks …`, `git …`), which is what makes the
 *  difference between `auto` and `never ask` matter here. */
const PERMISSION_HINTS: Record<AgentPermissionMode, string> = {
  manual: 'Claude asks before each edit and each command. Its default.',
  auto: 'Edits and safe commands go through unasked; anything risky still stops to ask. The mode Shift+Tab reaches in the terminal.',
  plan: 'Reads and proposes a plan, changes nothing.',
  bypassPermissions: 'Never asks about anything. The only mode a headless run can finish in, since nobody is there to answer.',
};

/** Shown verbatim so the run is never a surprise — and `manual` genuinely passes
 *  no flag, rather than being hidden behind a friendly word. */
const permissionFlag = computed(() =>
  permissionMode.value === 'manual' ? 'no --permission-mode flag' : `--permission-mode ${permissionMode.value}`,
);

/** Claude is the only harness with permission modes; pi has no equivalent. */
const supportsPermissions = computed(() => harness.value === 'claude');

/** A headless run cannot answer a question, so anything that might ask will
 *  sit there until it is stopped. */
const permissionStalls = computed(
  () => mode.value === 'print' && supportsPermissions.value && permissionMode.value !== 'bypassPermissions',
);

const isFinished = computed(
  () => !!run.value && run.value.status !== 'running' && run.value.status !== 'launched',
);

onMounted(async () => {
  try {
    const [env, runs] = await Promise.all([
      api.agentEnvironment(),
      api.listAgentRuns({ kind: props.subjectKind, ref: props.subjectRef }),
    ]);
    environment.value = env;
    history.value = runs;

    // Prefer an installed harness over the default one that is not.
    const installed = env.harnesses.find((one) => one.available);
    if (installed) harness.value = installed.id;
    if (!env.terminalAvailable) mode.value = 'print';
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
});

/**
 * Each run mode has its own sensible default, because the question is different:
 * a terminal run can answer a prompt, so `auto` leaves the risky ones to you; a
 * headless run cannot answer anything, so its only useful mode is the one that
 * never asks. Switching mode moves to that mode's default rather than carrying
 * a choice across into a place it means something else.
 */
watch(mode, (next) => {
  permissionMode.value = next === 'print' ? 'bypassPermissions' : 'auto';
});

watch(
  harness,
  async (id) => {
    if (!id) return;
    model.value = '';
    models.value = [];
    modelsError.value = null;
    modelsLoading.value = true;
    try {
      models.value = await api.agentModels(id);
    } catch (caught) {
      // A missing model list is not a reason to block the run: the harness's own
      // default is a perfectly good answer, and that is what an empty id means.
      modelsError.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      modelsLoading.value = false;
    }
  },
  { immediate: true },
);

async function start(): Promise<void> {
  starting.value = true;
  error.value = null;
  try {
    const started = await api.startAgentRun({
      harness: harness.value,
      model: model.value,
      mode: mode.value,
      command: props.command,
      target: props.target,
      extra: extra.value,
      subjectKind: props.subjectKind,
      subjectRef: props.subjectRef,
      permissionMode: permissionMode.value,
    });
    run.value = started;
    output.value = '';
    if (started.mode === 'print') poll();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    starting.value = false;
  }
}

/* --------------------------------------------------------------- polling */

let timer: ReturnType<typeof setTimeout> | null = null;

/** Poll the log while a headless run is going. Stops itself when the run does. */
function poll(): void {
  if (timer) clearTimeout(timer);
  const id = run.value?.id;
  if (id === undefined) return;

  const tick = async (): Promise<void> => {
    try {
      const detail = await api.getAgentRun(id);
      // A late response from a previous run must not overwrite the current one.
      if (run.value?.id !== id) return;
      run.value = detail;
      output.value = detail.output;
      if (detail.status === 'running') timer = setTimeout(tick, 1500);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  };

  void tick();
}

onUnmounted(() => {
  if (timer) clearTimeout(timer);
});

async function stop(): Promise<void> {
  if (!run.value) return;
  try {
    await api.stopAgentRun(run.value.id);
    poll();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

/** Reopen a past run's output without starting anything. */
async function showRun(id: number): Promise<void> {
  run.value = await api.getAgentRun(id);
  output.value = (run.value as AgentRunDetail).output;
  if (run.value.status === 'running') poll();
}

function again(): void {
  if (timer) clearTimeout(timer);
  run.value = null;
  output.value = '';
}

const formatTime = (value: string) => new Date(value).toLocaleString();

/** Keeps the newest output in view without fighting a user who scrolled up. */
const logEl = ref<HTMLElement | null>(null);
watch(output, () => {
  const element = logEl.value;
  if (!element) return;
  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  if (atBottom) requestAnimationFrame(() => (element.scrollTop = element.scrollHeight));
});
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog agent-dialog">
      <h3>{{ LABEL[command] }} with an agent</h3>
      <p class="faint" style="margin-top: -6px">
        <span class="mono">{{ target || 'no ref — the command picks one' }}</span>
        <template v-if="subjectTitle"> · {{ subjectTitle }}</template>
      </p>

      <p v-if="error" class="banner">{{ error }}</p>

      <!-- ------------------------------------------------------ setup form -->
      <template v-if="!run">
        <div class="field">
          <label for="agent-extra">Extra prompt <span class="faint">(optional)</span></label>
          <textarea
            id="agent-extra"
            v-model="extra"
            style="min-height: 110px"
            placeholder="Anything the agent should know that the issue or task does not already say — where to start, what to leave alone, what you already ruled out."
          />
        </div>

        <div class="row">
          <div class="field" style="flex: 1">
            <label for="agent-harness">Harness</label>
            <select id="agent-harness" v-model="harness">
              <option
                v-for="one in environment?.harnesses ?? []"
                :key="one.id"
                :value="one.id"
                :disabled="!one.available"
              >
                {{ one.label }}{{ one.available ? '' : ' — not on PATH' }}
              </option>
            </select>
          </div>

          <div class="field" style="flex: 2">
            <label for="agent-model">
              Model
              <span v-if="modelsLoading" class="faint">— loading…</span>
              <span v-else-if="modelsError" class="faint">— unavailable, using the default</span>
            </label>
            <select id="agent-model" v-model="model" :disabled="modelsLoading || !!modelsError">
              <template v-for="[group, entries] in groupedModels" :key="group">
                <optgroup v-if="group" :label="group">
                  <option v-for="entry in entries" :key="entry.id" :value="entry.id">
                    {{ entry.label }}
                  </option>
                </optgroup>
                <option v-for="entry in group ? [] : entries" :key="entry.id" :value="entry.id">
                  {{ entry.label }}
                </option>
              </template>
            </select>
          </div>
        </div>

        <div class="field">
          <label>How to run it</label>
          <label class="agent-mode">
            <input v-model="mode" type="radio" value="terminal" :disabled="!environment?.terminalAvailable" />
            <span>
              <strong>Open a terminal window</strong>
              <span class="faint">
                — {{ chosenHarness?.label ?? 'the agent' }} runs interactively in
                {{ environment?.terminal ?? 'a terminal' }}, so you can answer it and steer it.
                <template v-if="!environment?.terminalAvailable">
                  No terminal emulator was found; set "agentTerminal" in tasks.config.json.
                </template>
              </span>
            </span>
          </label>
          <label class="agent-mode">
            <input v-model="mode" type="radio" value="print" />
            <span>
              <strong>Headless (<span class="mono">-p</span>)</strong>
              <span class="faint">
                — runs detached with its output captured here. Nobody can answer a
                question it asks.
              </span>
            </span>
          </label>
        </div>

        <div v-if="supportsPermissions" class="field">
          <label for="agent-permission">What it may do without asking</label>
          <select id="agent-permission" v-model="permissionMode">
            <option v-for="(label, id) in AGENT_PERMISSION_MODE_LABELS" :key="id" :value="id">
              {{ label }}
            </option>
          </select>
          <p class="faint">
            {{ PERMISSION_HINTS[permissionMode] }}
            <br />
            Passed as <span class="mono">{{ permissionFlag }}</span>.
          </p>
          <p v-if="permissionStalls" class="banner warn">
            A headless run has nobody to answer a prompt, so
            <strong>{{ AGENT_PERMISSION_MODE_LABELS[permissionMode] }}</strong> will leave it
            waiting on the first thing it wants to check. Both commands are mostly shell
            (<span class="mono">tasks</span>, <span class="mono">git</span>), so that is usually
            immediate.
          </p>
        </div>

        <div class="field">
          <label>Prompt</label>
          <pre class="agent-preview mono">{{ preview }}</pre>
        </div>

        <div class="row">
          <button
            class="primary"
            :disabled="starting || !chosenHarness?.available"
            @click="start"
          >
            {{ starting ? 'Starting…' : 'Run' }}
          </button>
          <button :disabled="starting" @click="emit('close')">Cancel</button>
        </div>

        <!-- ------------------------------------------------- earlier runs -->
        <div v-if="history.length" class="section" style="margin-top: 4px">
          <h3>Earlier runs</h3>
          <ul class="agent-history">
            <li v-for="entry in history" :key="entry.id">
              <button class="linkish" @click="showRun(entry.id)">
                <span class="badge" :class="`agent-${entry.status}`">{{ entry.status }}</span>
                <span class="mono faint">{{ entry.harness }}{{ entry.model ? ` · ${entry.model}` : '' }}</span>
                <span class="faint">{{ entry.mode === 'print' ? 'headless' : 'terminal' }}</span>
                <span class="spacer" />
                <time class="faint">{{ formatTime(entry.createdAt) }}</time>
              </button>
            </li>
          </ul>
        </div>
      </template>

      <!-- ----------------------------------------------------- running run -->
      <template v-else>
        <div class="row" style="flex-wrap: wrap">
          <span class="badge" :class="`agent-${run.status}`">{{ run.status }}</span>
          <span class="mono faint">{{ run.harness }}{{ run.model ? ` · ${run.model}` : '' }}</span>
          <span class="faint">{{ run.mode === 'print' ? 'headless' : 'terminal window' }}</span>
          <span v-if="run.exitCode !== null" class="faint">exit {{ run.exitCode }}</span>
        </div>

        <p v-if="run.mode === 'terminal'" class="agent-terminal-note">
          A terminal window is open with {{ run.harness }} running
          <span class="mono">{{ `/${run.command}` }}</span>. It is a session of its own from
          here on — answer it there. Anything it files shows up in this app as it happens.
        </p>

        <template v-else>
          <pre ref="logEl" class="agent-log mono">{{ output || 'Waiting for output…' }}</pre>
          <p v-if="(run as AgentRunDetail).truncated" class="faint">
            Showing the tail of a longer log.
          </p>
        </template>

        <div class="row">
          <button v-if="!isFinished && run.mode === 'print'" class="danger" @click="stop">Stop</button>
          <button v-if="isFinished" @click="again">Run another</button>
          <span class="spacer" />
          <button class="primary" @click="emit('close')">
            {{ isFinished || run.mode === 'terminal' ? 'Close' : 'Close (keeps running)' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
