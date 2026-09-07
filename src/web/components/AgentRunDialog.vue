<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  AGENT_PERMISSION_MODE_LABELS,
  type AgentCommand,
  type AgentEnvironment,
  type AgentHarnessId,
  type AgentModel,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunMode,
  GROUP_RUN_STATUS_LABELS,
  type GroupRun,
  type ModelTier,
  type Task,
} from '@shared/types';
import { api } from '../api';

/**
 * Point an agent at whatever is on screen.
 *
 * The same dialog drives every command — `plan-tasks` from an issue, `work-task`
 * from a task, `work-group` from a group — because the only thing that differs
 * between them is the command name and its argument, and the server inlines
 * each one's instructions from this package's `prompts/` folder rather than
 * relying on anything installed separately in Claude Code, Codex or `pi`.
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
  /**
   * What an investigation judged this task needs, if anything did. Used only to
   * pick a starting value for the model dropdown — via `environment.modelTiers`
   * for whichever harness ends up selected — never to constrain the choice.
   */
  recommendedTier?: ModelTier | null;
  /**
   * Why a new run cannot be started, or null when one can.
   *
   * The dialog still opens — its history and its Resume buttons are the reason
   * to come here when there is nothing left to start — but Run is refused and
   * says why rather than launching an agent with no work to do.
   */
  startBlockedReason?: string | null;
  /**
   * Set to a group ref to run that whole group unattended instead of running
   * one command.
   *
   * The dialog is the same because the choices are the same — harness, model,
   * what it may do without asking, what else it should know — and they are
   * chosen once and used for every task in the loop. What changes is what Run
   * starts: a loop the server drives, launching a fresh `/work-task` per task,
   * rather than a single agent.
   */
  loopGroupRef?: string | null;
  /**
   * An existing loop to attach to instead of offering to start one.
   *
   * A loop outlives the tab that started it, so the way back to a run already in
   * flight has to be a dialog that opens straight onto its log rather than onto
   * a form offering to start a second.
   */
  attachGroupRunId?: number | null;
  /** Unfinished tasks offered for inclusion when configuring a group loop. */
  groupTasks?: Task[];
}>();

/** True when Run starts a loop over a group rather than one command. */
const isLoop = computed(() => !!props.loopGroupRef);

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
const excluded = ref<string[]>([]);

const error = ref<string | null>(null);
const starting = ref(false);
const run = ref<AgentRunDetail | AgentRun | null>(null);
const output = ref('');
const history = ref<AgentRun[]>([]);
/** The loop in flight, when this dialog started one. Its `currentRunId` is what
 *  the log below is following, and it moves on as tasks finish. */
const groupRun = ref<GroupRun | null>(null);

const LABEL: Record<AgentCommand, string> = {
  'plan-tasks': 'Investigate',
  'work-task': 'Work task',
  'work-group': 'Work group',
};

const heading = computed(() =>
  isLoop.value ? `Work ${props.loopGroupRef} unattended` : `${LABEL[props.command]} with an agent`,
);

const chosenHarness = computed(
  () => environment.value?.harnesses.find((one) => one.id === harness.value) ?? null,
);

/** The prompt as the server will assemble it. Shown so nothing is a surprise. */
const preview = computed(() => {
  // A loop sends this once per task, with the ref filled in each time — showing
  // one ref would claim it runs once, which is the thing worth not implying.
  const head = isLoop.value
    ? `/work-task <each task in ${props.loopGroupRef}'s work order, one fresh agent each>`
    : props.target
      ? `/${props.command} ${props.target}`
      : `/${props.command}`;
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
const permissionHints = computed<Record<AgentPermissionMode, string>>(() => ({
  manual: `${chosenHarness.value?.label ?? 'The agent'} uses its normal approval behavior.`,
  auto: 'Routine workspace work proceeds automatically; risky actions can still require approval.',
  plan: 'Reads and proposes a plan, changes nothing.',
  bypassPermissions: 'Never asks about anything. Intended for an already isolated environment.',
}));

/** Shown verbatim so the run is never a surprise — and `manual` genuinely passes
 *  no flag, rather than being hidden behind a friendly word. */
const permissionFlag = computed(() => {
  if (permissionMode.value === 'manual') return 'no permission flag';
  if (harness.value === 'codex') {
    if (permissionMode.value === 'auto') return '--approve-for-me';
    if (permissionMode.value === 'plan') return '--sandbox read-only';
    return '--dangerously-bypass-approvals-and-sandbox';
  }
  return `--permission-mode ${permissionMode.value}`;
});

/** pi has no equivalent permission/sandbox controls. */
const supportsPermissions = computed(() => harness.value !== 'pi');

/** A headless run cannot answer a question, so anything that might ask will
 *  sit there until it is stopped. */
const permissionStalls = computed(
  () => mode.value === 'print' && supportsPermissions.value && permissionMode.value !== 'bypassPermissions',
);

/**
 * Reopen a run's conversation in a terminal.
 *
 * Available whatever the run's state: a finished session is the usual case
 * ("what did it decide?"), and a terminal run whose window was closed is the
 * other. Only a run launched before session ids were recorded cannot.
 */
const resuming = ref(false);

async function resume(id: number): Promise<void> {
  resuming.value = true;
  error.value = null;
  try {
    await api.resumeAgentRun(id);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    resuming.value = false;
  }
}

const isFinished = computed(() => {
  // Mid-loop, the agent that just exited is not the end of anything — the loop's
  // own status is what says whether there is more coming.
  if (groupRun.value) return groupRun.value.status !== 'running';
  return !!run.value && run.value.status !== 'running' && run.value.status !== 'launched';
});

onMounted(async () => {
  try {
    const [env, runs] = await Promise.all([
      api.agentEnvironment(),
      api.listAgentRuns({ kind: props.subjectKind, ref: props.subjectRef }),
    ]);
    environment.value = env;
    history.value = runs;
    applyRecommendedTier();

    // Prefer an installed harness over the default one that is not.
    const installed = env.harnesses.find((one) => one.available);
    if (installed) harness.value = installed.id;
    // A loop is headless and there is no choice about it: a terminal run's pid
    // belongs to the emulator, so the server has nothing to wait on to know the
    // task is over, and an agent that can ask questions holds up the queue.
    if (!env.terminalAvailable || isLoop.value) mode.value = 'print';

    if (props.loopGroupRef && props.attachGroupRunId) {
      const existing = (await api.listGroupRuns(props.loopGroupRef)).find(
        (one) => one.id === props.attachGroupRunId,
      );
      // Without an agent recorded against it there is no log to open onto, and
      // the setup form is the more useful thing to show.
      if (existing?.currentRunId) {
        groupRun.value = existing;
        run.value = await api.getAgentRun(existing.currentRunId);
        output.value = (run.value as AgentRunDetail).output;
        poll();
      }
    }
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

/**
 * Fill the model dropdown from the task's recommended tier, resolved through
 * `environment.modelTiers` for whichever harness is selected. Only ever moves
 * `model` out of "unset" — it never overwrites a choice already made, by the
 * user or by an earlier call here, so it is safe to call opportunistically
 * from wherever a piece it depends on (environment, harness, the model list)
 * finishes loading, in whatever order that happens to be.
 */
function applyRecommendedTier(): void {
  if (model.value || !props.recommendedTier || !environment.value) return;
  const candidate = environment.value.modelTiers[harness.value as AgentHarnessId]?.[props.recommendedTier];
  if (candidate && models.value.some((entry) => entry.id === candidate)) {
    model.value = candidate;
  }
}

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
      applyRecommendedTier();
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
    if (props.loopGroupRef) {
      const started = await api.startGroupRun(props.loopGroupRef, {
        harness: harness.value,
        model: model.value,
        permissionMode: permissionMode.value,
        extra: extra.value,
        excluded: excluded.value,
      });
      groupRun.value = started.groupRun;
      run.value = started.run;
      output.value = '';
      poll();
      return;
    }

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
/** Bumped every time polling is (re)started, so a tick from an abandoned poll
 *  cannot write over what the current one is showing. */
let pollToken = 0;

/**
 * Poll the log while something is going, and stop when it does.
 *
 * A loop is followed rather than a run: the agent in flight changes each time a
 * task lands, so every tick re-reads which one that is and switches the log to
 * it. That is also why the loop's status, not the agent's, decides whether to
 * keep polling — one agent finishing is the middle of a loop, not the end.
 */
function poll(): void {
  if (timer) clearTimeout(timer);
  const token = ++pollToken;

  const tick = async (): Promise<void> => {
    try {
      if (groupRun.value && props.loopGroupRef) {
        const runs = await api.listGroupRuns(props.loopGroupRef);
        if (token !== pollToken) return;
        const fresh = runs.find((one) => one.id === groupRun.value?.id);
        if (fresh) groupRun.value = fresh;
      }

      const id = groupRun.value ? groupRun.value.currentRunId : (run.value?.id ?? null);
      if (id === null || id === undefined) return;

      const detail = await api.getAgentRun(id);
      if (token !== pollToken) return;
      run.value = detail;
      output.value = detail.output;

      const going = groupRun.value ? groupRun.value.status === 'running' : detail.status === 'running';
      if (going) timer = setTimeout(tick, 1500);
    } catch (caught) {
      if (token !== pollToken) return;
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
    // Stopping a loop kills the agent in flight too, so this is the one call.
    // Tasks it already merged stay merged — a partly delivered group is the
    // normal recoverable state, not a mess to unwind.
    if (groupRun.value && props.loopGroupRef) await api.stopGroupRun(props.loopGroupRef);
    else await api.stopAgentRun(run.value.id);
    poll();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

/** Reopen a past run's output without starting anything. */
async function showRun(id: number): Promise<void> {
  groupRun.value = null;
  run.value = await api.getAgentRun(id);
  output.value = (run.value as AgentRunDetail).output;
  if (run.value.status === 'running') poll();
}

function again(): void {
  if (timer) clearTimeout(timer);
  pollToken += 1;
  run.value = null;
  groupRun.value = null;
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
      <h3>{{ heading }}</h3>
      <p class="faint" style="margin-top: -6px">
        <span class="mono">{{ isLoop ? loopGroupRef : target || 'no ref — the command picks one' }}</span>
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

        <div v-if="isLoop" class="field">
          <label>How it runs</label>
          <p class="faint" style="margin: 0">
            One headless <span class="mono">/work-task</span> per task, in the group's work
            order, each with a context of its own — which is the point: a single session
            working six tasks is carrying five tasks' worth of transcript by the sixth.
            The next one starts when the previous agent exits <em>and</em> its task has
            actually reached Dev Complete. Anything else — a merge conflict, a question, a
            task that did not move — stops the loop and leaves what already merged alone.
          </p>
        </div>

        <fieldset v-if="isLoop" class="field group-run-tasks">
          <legend>Tasks to run</legend>
          <p class="faint">Clear any task you want this run to leave untouched.</p>
          <label v-for="task in groupTasks ?? []" :key="task.ref" class="agent-mode">
            <input
              type="checkbox"
              :checked="!excluded.includes(task.ref)"
              @change="excluded = ($event.target as HTMLInputElement).checked
                ? excluded.filter((ref) => ref !== task.ref)
                : [...excluded, task.ref]"
            />
            <span><strong class="mono">{{ task.ref }}</strong><span>{{ task.title }}</span></span>
          </label>
        </fieldset>

        <div v-else class="field">
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
            {{ permissionHints[permissionMode] }}
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
            :disabled="starting || !chosenHarness?.available || !!startBlockedReason ||
              (isLoop && excluded.length === (groupTasks?.length ?? 0))"
            :title="startBlockedReason ?? undefined"
            @click="start"
          >
            {{ starting ? 'Starting…' : isLoop ? 'Run the group' : 'Run' }}
          </button>
          <button :disabled="starting" @click="emit('close')">Cancel</button>
        </div>

        <p v-if="startBlockedReason" class="faint" style="margin: 0">
          {{ startBlockedReason }}
        </p>
        <p v-else-if="isLoop && excluded.length === (groupTasks?.length ?? 0)" class="faint" style="margin: 0">
          Select at least one task to run.
        </p>

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
              <!-- Disabled rather than hidden on an older run: the absence is
                   worth explaining once, not silently. -->
              <button
                class="agent-resume"
                :disabled="!entry.sessionId || resuming"
                :title="entry.sessionId
                  ? `Reopen this ${entry.harness} conversation in a terminal`
                  : 'This run has no recorded conversation id. Older runs and interactive Codex runs cannot be reopened here.'"
                @click="resume(entry.id)"
              >
                Resume
              </button>
            </li>
          </ul>
        </div>
      </template>

      <!-- ----------------------------------------------------- running run -->
      <template v-else>
        <div v-if="groupRun" class="panel group-run-progress">
          <div class="row" style="flex-wrap: wrap">
            <span class="badge" :class="`group-run-${groupRun.status}`">
              {{ GROUP_RUN_STATUS_LABELS[groupRun.status] }}
            </span>
            <span class="faint">
              {{ groupRun.worked.length }} task(s) finished
              <template v-if="groupRun.currentRef && groupRun.status === 'running'">
                · working <span class="mono">{{ groupRun.currentRef }}</span>
              </template>
            </span>
          </div>
          <p v-if="groupRun.worked.length" class="faint" style="margin: 8px 0 0">
            Merged into the group branch:
            <span class="mono">{{ groupRun.worked.join(', ') }}</span>
          </p>
          <p v-if="groupRun.excluded.length" class="faint" style="margin: 8px 0 0">
            Excluded from this run: <span class="mono">{{ groupRun.excluded.join(', ') }}</span>
          </p>
          <p v-if="groupRun.stopReason" class="banner warn" style="margin: 10px 0 0">
            {{ groupRun.stopReason }}
          </p>
        </div>

        <div class="row" style="flex-wrap: wrap">
          <span class="badge" :class="`agent-${run.status}`">{{ run.status }}</span>
          <span v-if="groupRun?.currentRef" class="mono faint">{{ groupRun.currentRef }}</span>
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
          <button v-if="!isFinished && run.mode === 'print'" class="danger" @click="stop">
            {{ groupRun ? 'Stop the group' : 'Stop' }}
          </button>
          <button
            v-if="run.sessionId"
            :disabled="resuming"
            :title="`Reopen this ${run.harness} conversation in a terminal`"
            @click="resume(run.id)"
          >
            {{ resuming ? 'Opening…' : 'Resume' }}
          </button>
          <button v-if="isFinished" @click="again">Run another</button>
          <span class="spacer" />
          <button class="primary" @click="emit('close')">
            {{ isFinished || run.mode === 'terminal' ? 'Close' : 'Close (keeps going)' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
