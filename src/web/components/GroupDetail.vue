<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  GROUP_COLORS,
  GROUP_RUN_STATUS_LABELS,
  groupQueueBlockers,
  groupRunActive,
  nextWorkableTask,
  STATUS_LABELS,
  type AgentCommand,
  type GroupAdvanceOutcome,
  type TaskGroupDetail,
} from '@shared/types';
import { api } from '../api';
import AgentRunDialog from './AgentRunDialog.vue';
import MarkdownBlock from './MarkdownBlock.vue';

/**
 * The group as a piece of work in its own right: what is in it, what order it
 * can be done in, and the state of the branch it all lands on.
 *
 * The branch is the reason this page exists. A group used to be a heading over
 * some rows; now it owns the branch its tasks are cut from and merged back into,
 * and that is not something a heading can show.
 */
const props = defineProps<{ group: TaskGroupDetail }>();
const emit = defineEmits<{
  changed: [TaskGroupDetail];
  deleted: [string];
  openTask: [string];
  openBranch: [string];
}>();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);

/** What the agent dialog is currently pointed at, or null when it is shut. One
 *  dialog serves both buttons: the whole group, and the next task in it. */
const launch = ref<{
  command: AgentCommand;
  target: string;
  subjectKind: string;
  subjectRef: string;
  subjectTitle: string;
  /** Passed to the dialog, which opens either way and refuses Run. */
  startBlockedReason?: string | null;
  /** Set to run the whole group unattended rather than one command. */
  loopGroupRef?: string | null;
  /** Set to open onto a loop already in flight instead of offering a new one. */
  attachGroupRunId?: number | null;
} | null>(null);
const editing = ref(false);
const copied = ref(false);
/** What the last sign-off sweep did, task by task — see `signOff` below. */
const outcomes = ref<GroupAdvanceOutcome[] | null>(null);
const showCommits = ref(false);

const draft = ref({ name: '', description: '', color: '', branchName: '' });

watch(
  () => props.group.ref,
  () => {
    editing.value = false;
    error.value = null;
    copied.value = false;
    showCommits.value = false;
    outcomes.value = null;
  },
);

function beginEdit(): void {
  draft.value = {
    name: props.group.name,
    description: props.group.description,
    color: props.group.color,
    branchName: props.group.branchName,
  };
  editing.value = true;
}

/** Wraps every mutation so one failure path handles the spinner and the error. */
async function run(label: string, action: () => Promise<unknown>): Promise<void> {
  busy.value = label;
  error.value = null;
  try {
    await action();
    emit('changed', await api.getGroup(props.group.ref));
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

const save = () =>
  run('save', () =>
    api.updateGroup(props.group.ref, {
      name: draft.value.name,
      description: draft.value.description,
      color: draft.value.color,
      branchName: draft.value.branchName.trim() || undefined,
    }),
  ).then(() => {
    if (!error.value) editing.value = false;
  });

async function remove(): Promise<void> {
  const kept = props.group.taskCount
    ? `Its ${props.group.taskCount} task(s) are kept and become ungrouped.`
    : 'It is empty.';
  if (!confirm(`Delete ${props.group.ref} (${props.group.name})? ${kept}`)) return;

  busy.value = 'delete';
  try {
    await api.deleteGroup(props.group.ref);
    emit('deleted', props.group.ref);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

/** A run works tasks, merges branches and moves statuses, so nothing on this
 *  page survives it — reload the lot when the dialog closes. */
async function agentDialogClosed(): Promise<void> {
  launch.value = null;
  try {
    emit('changed', await api.getGroup(props.group.ref));
  } catch {
    // Deleted by whatever ran; the task list column will reflect that.
  }
}

const command = computed(() => `/work-group ${props.group.ref}`);

async function copyCommand(): Promise<void> {
  await navigator.clipboard.writeText(command.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

/* ------------------------------------------------------------------ queue */

/** Both shared with the server, which has to pick the same next task this page
 *  names — two implementations of "next" is how they would stop agreeing. */
const blockedBy = computed(() => groupQueueBlockers(props.group));
const nextUp = computed(() => nextWorkableTask(props.group));

/** The one task in flight anywhere, if there is one. `/work-task` allows exactly
 *  none before it will start another. */
const inFlight = computed(() => props.group.inProgress[0] ?? null);

/**
 * Why the next task cannot be started, or null when it can.
 *
 * Resuming the in-flight task is not blocked — that is what `/work-task` calls
 * carrying on rather than starting a second one — so it only refuses when the
 * task in flight is a *different* one.
 */
const blockedReason = computed(() => {
  if (!nextUp.value) {
    return props.group.queue.length
      ? 'Everything left in this group is waiting on something unfinished.'
      : null;
  }
  // A loop owns the whole group while it runs, so starting a task by hand
  // beside it would put two agents in one working tree.
  if (activeRun.value) {
    return `${props.group.ref} is being worked unattended by group run ${activeRun.value.id}. Stop that first.`;
  }
  const flight = inFlight.value;
  if (flight && flight.ref !== nextUp.value.ref) {
    return `${flight.ref} (${flight.title}) is already in progress. Finish or park it first — a task owns a branch and a checkpoint, and two at once corrupts both.`;
  }
  return null;
});

/**
 * Why a fresh group run has nothing to do, or null when it has.
 *
 * It does not close the dialog off — a finished group's run history and its
 * Resume buttons are the only way back into the session that did the work — so
 * the button stays live and the dialog refuses Run instead.
 */
const emptyQueueReason = computed(() =>
  !props.group.queue.length ? 'There is nothing left in this group for an agent to work.' : null,
);

/** Already started, so the agent picks it up rather than beginning it. */
const resuming = computed(() => !!nextUp.value && inFlight.value?.ref === nextUp.value.ref);

function startNext(): void {
  const task = nextUp.value;
  if (!task || blockedReason.value) return;
  launch.value = {
    command: 'work-task',
    target: task.ref,
    subjectKind: 'task',
    subjectRef: task.ref,
    subjectTitle: task.title,
  };
}

/* ------------------------------------------------------------- group runs */

/**
 * Working the whole group unattended.
 *
 * The Start button above does one task and stops, which is the right default —
 * you read what it did before deciding the next one is still a good idea. This
 * is the same thing without the stopping: the server launches a fresh
 * `/work-task` per task and moves on when the previous one has actually reached
 * Dev Complete, so a six-task group is six agents with six empty contexts
 * rather than one conversation carrying all six.
 */
const activeRun = computed(() => (groupRunActive(props.group.run) ? props.group.run : null));

/** Why the group cannot be run unattended, or null when it can. The server
 *  checks all of this again — this is so the button can say why beforehand. */
const loopBlockedReason = computed(() => {
  if (activeRun.value) return null;
  return emptyQueueReason.value ?? blockedReason.value;
});

function runGroup(): void {
  if (loopBlockedReason.value) return;
  launch.value = {
    command: 'work-task',
    target: '',
    subjectKind: 'group',
    subjectRef: props.group.ref,
    subjectTitle: props.group.name,
    loopGroupRef: props.group.ref,
  };
}

/** Reopen the log of a loop already going — it outlives the tab that started it. */
function watchRun(): void {
  const run = props.group.run;
  if (!run) return;
  launch.value = {
    command: 'work-task',
    target: '',
    subjectKind: 'group',
    subjectRef: props.group.ref,
    subjectTitle: props.group.name,
    loopGroupRef: props.group.ref,
    attachGroupRunId: run.id,
  };
}

const stopRun = () => run('stop-run', () => api.stopGroupRun(props.group.ref));

const finished = computed(() =>
  props.group.tasks.filter((task) => task.status !== 'backlog' && task.status !== 'in_progress'),
);

/* --------------------------------------------------------------- sign off */

/**
 * Finishing the group as one piece.
 *
 * A group is worked as a unit and it is signed off as one too — walking every
 * member through Verified and Closed by hand is the same decision typed out N
 * times. Closing takes Dev Complete tasks through Verified on the way, so the
 * two buttons are one action at two depths rather than a sequence to remember.
 */
const readyToVerify = computed(() =>
  props.group.tasks.filter((task) => task.status === 'dev_complete'),
);

/** Verified tasks are already signed off but not yet cleaned up, so a close
 *  sweep takes them along with the ones it verifies on the way. */
const readyToClose = computed(() =>
  props.group.tasks.filter((task) => task.status === 'dev_complete' || task.status === 'verified'),
);

const stillWorking = computed(() =>
  props.group.tasks.filter((task) => task.status === 'backlog' || task.status === 'in_progress'),
);

/** What the last sweep actually did, for the line above the per-task list. */
const outcomeSummary = computed(() => {
  const list = outcomes.value ?? [];
  return {
    moved: list.filter((one) => one.to && !one.error).length,
    failed: list.filter((one) => one.error).length,
    untouched: list.filter((one) => one.skipped).length,
  };
});

function signOff(status: 'verified' | 'closed'): void {
  const targets = status === 'verified' ? readyToVerify.value : readyToClose.value;
  if (!targets.length) return;
  if (
    status === 'closed' &&
    !confirm(
      `Close ${targets.length} task(s) in ${props.group.ref} (${props.group.name})? ` +
        'Anything still at Dev Complete is verified on the way, and each task\'s visual ' +
        'checkpoint is cleaned off disk.',
    )
  ) {
    return;
  }

  outcomes.value = null;
  void run(`sign-off-${status}`, async () => {
    outcomes.value = (await api.advanceGroup(props.group.ref, status)).outcomes;
  });
}

/** Registered on the branch by `tasks done`, so this is the roster the group's
 *  PR would carry rather than a guess from the task list. */
const registered = computed(() => new Set(props.group.delivery?.taskRefs ?? []));
</script>

<template>
  <section class="detail">
    <p v-if="error" class="banner">{{ error }}</p>

    <AgentRunDialog
      v-if="launch"
      :key="launch.subjectRef"
      :command="launch.command"
      :target="launch.target"
      :subject-kind="launch.subjectKind"
      :subject-ref="launch.subjectRef"
      :subject-title="launch.subjectTitle"
      :start-blocked-reason="launch.startBlockedReason ?? null"
      :loop-group-ref="launch.loopGroupRef ?? null"
      :attach-group-run-id="launch.attachGroupRunId ?? null"
      @close="agentDialogClosed"
    />

    <!-- ------------------------------------------------------------ header -->
    <template v-if="!editing">
      <div class="detail-header">
        <span class="group-dot" :style="{ background: group.color }" aria-hidden="true" />
        <span class="mono dim">{{ group.ref }}</span>
        <h2>{{ group.name }}</h2>
      </div>

      <div class="detail-meta">
        <span class="faint">
          {{ group.openCount }} open / {{ group.taskCount }} task{{ group.taskCount === 1 ? '' : 's' }}
        </span>
        <button
          v-if="group.investigationRef"
          class="task-chip"
          :title="`From investigation ${group.investigationRef}`"
        >
          <span class="faint">from</span>
          <span class="mono">{{ group.investigationRef }}</span>
        </button>
        <span class="spacer" />
        <button :disabled="!!busy" @click="beginEdit">Edit</button>
        <button class="danger" :disabled="!!busy" @click="remove">Delete</button>
      </div>

      <MarkdownBlock v-if="group.description" :source="group.description" />
    </template>

    <!-- ------------------------------------------------------------- edit -->
    <div v-else class="panel">
      <div class="field">
        <label for="group-detail-name">Name</label>
        <input id="group-detail-name" v-model="draft.name" @keyup.enter="save" />
      </div>
      <div class="field">
        <label for="group-detail-desc">Description</label>
        <textarea id="group-detail-desc" v-model="draft.description" style="min-height: 70px" />
      </div>
      <div class="field">
        <label for="group-detail-branch">Branch</label>
        <input id="group-detail-branch" v-model="draft.branchName" class="mono" />
        <p class="faint">
          Repointing this does not rename the Git branch, and work already merged into
          the old one stays there.
        </p>
      </div>
      <div class="field">
        <label>Colour</label>
        <div class="row group-colors">
          <button
            v-for="color in GROUP_COLORS"
            :key="color"
            class="group-color"
            :class="{ chosen: draft.color === color }"
            :style="{ background: color }"
            :aria-label="color"
            :aria-pressed="draft.color === color"
            @click="draft.color = color"
          />
        </div>
      </div>
      <div class="row">
        <button class="primary" :disabled="!draft.name.trim() || !!busy" @click="save">
          {{ busy === 'save' ? 'Saving…' : 'Save' }}
        </button>
        <button :disabled="!!busy" @click="editing = false">Cancel</button>
      </div>
    </div>

    <!-- ----------------------------------------------------------- branch -->
    <div class="section">
      <h3>Branch</h3>
      <div class="panel">
        <div class="row" style="flex-wrap: wrap; margin-bottom: 10px">
          <code class="mono command">{{ group.branchName }}</code>
          <span class="faint">from <code class="mono">{{ group.baseBranch }}</code></span>
        </div>

        <!-- A group nobody has started has no branch yet, and that is the normal
             state rather than something to warn about. -->
        <p v-if="!group.git.exists" class="faint" style="margin: 0">
          Not created yet. It is cut from <code class="mono">{{ group.baseBranch }}</code> the
          first time a task in this group is branched.
        </p>

        <template v-else>
          <div class="row" style="flex-wrap: wrap; margin-bottom: 10px">
            <strong>{{ group.git.commits.length }}</strong>
            <span class="faint">commit(s) ahead of {{ group.baseBranch }}</span>
            <span class="faint">· {{ group.git.filesChanged }} file(s) changed</span>
            <span v-if="group.git.upstream" class="faint">
              · pushed to <code class="mono">{{ group.git.upstream }}</code>
            </span>
            <span v-else class="faint">· not pushed</span>
          </div>

          <div class="row" style="flex-wrap: wrap">
            <button v-if="group.git.commits.length" @click="showCommits = !showCommits">
              {{ showCommits ? 'Hide' : 'Show' }} commits
            </button>
            <!-- The delivery record is what the Branches view draws, so this is
                 a jump to the same branch rather than a second version of it. -->
            <button v-if="group.delivery" @click="emit('openBranch', group.branchName)">
              Open in Branches
            </button>
            <a
              v-if="group.delivery?.prUrl"
              class="task-chip"
              :href="group.delivery.prUrl"
              target="_blank"
              rel="noreferrer"
            >
              PR #{{ group.delivery.prNumber }}
            </a>
          </div>

          <ul v-if="showCommits" class="commit-list">
            <li v-for="commit in group.git.commits" :key="commit.sha">
              <code class="mono faint">{{ commit.shortSha }}</code>
              <span>{{ commit.subject }}</span>
            </li>
          </ul>
        </template>
      </div>
    </div>

    <!-- ---------------------------------------------------------- next up -->
    <div v-if="group.queue.length" class="section">
      <h3>Next up</h3>
      <div class="panel">
        <div v-if="nextUp" class="row next-up">
          <button class="task-chip" :title="nextUp.title" @click="emit('openTask', nextUp.ref)">
            <span class="mono">{{ nextUp.ref }}</span>
            <span class="badge" :class="nextUp.status">{{ STATUS_LABELS[nextUp.status] }}</span>
            <span class="task-chip-title">{{ nextUp.title }}</span>
          </button>
          <span class="spacer" />
          <button
            class="primary"
            :disabled="!!busy || !!blockedReason"
            :title="blockedReason ?? `Point an agent at ${nextUp.ref}, branched from ${group.branchName}`"
            @click="startNext"
          >
            {{ resuming ? 'Continue' : 'Start' }}
          </button>
        </div>
        <p v-else class="faint" style="margin: 0">
          Nothing in this group can be started right now.
        </p>

        <p v-if="blockedReason" class="faint" style="margin: 10px 0 0">{{ blockedReason }}</p>
        <p v-else-if="nextUp" class="faint" style="margin: 10px 0 0">
          Start works one task and stops, so you can read what it did before deciding the
          next one is still a good idea.
        </p>
      </div>
    </div>

    <!-- ------------------------------------------------------- unattended -->
    <div v-if="group.queue.length || group.run" class="section">
      <h3>Run the whole group</h3>
      <div class="panel">
        <!-- A loop in flight, which outlives the tab that started it — hence a
             way back into its log that is not the button that started it. -->
        <template v-if="activeRun">
          <div class="row" style="flex-wrap: wrap">
            <span class="badge group-run-running">
              {{ GROUP_RUN_STATUS_LABELS[activeRun.status] }}
            </span>
            <span class="faint">
              {{ activeRun.worked.length }} finished
              <template v-if="activeRun.currentRef">
                · working <span class="mono">{{ activeRun.currentRef }}</span>
              </template>
            </span>
            <span class="spacer" />
            <button @click="watchRun">Watch</button>
            <button class="danger" :disabled="busy === 'stop-run'" @click="stopRun">
              {{ busy === 'stop-run' ? 'Stopping…' : 'Stop' }}
            </button>
          </div>
          <p class="faint" style="margin: 10px 0 0">
            A fresh agent per task, each starting from nothing. Stopping kills the one in
            flight; the tasks it already merged stay merged.
          </p>
        </template>

        <template v-else>
          <div class="row">
            <span class="faint">
              One headless <span class="mono">/work-task</span> per task, in the work order,
              each with a context of its own. The next starts only once the previous task has
              actually reached Dev Complete.
            </span>
            <span class="spacer" />
            <button
              class="primary"
              :disabled="!!busy || !!loopBlockedReason"
              :title="loopBlockedReason ?? `Work all ${group.queue.length} of ${group.ref}'s tasks unattended`"
              @click="runGroup"
            >
              Run the group
            </button>
          </div>

          <!-- The last run, whatever became of it. A stopped run's reason is the
               only place the thing that stopped it is written down. -->
          <div v-if="group.run" class="row group-run-last">
            <span class="badge" :class="`group-run-${group.run.status}`">
              {{ GROUP_RUN_STATUS_LABELS[group.run.status] }}
            </span>
            <span class="faint">
              last run finished {{ group.run.worked.length }} task(s)
              <template v-if="group.run.worked.length">
                — <span class="mono">{{ group.run.worked.join(', ') }}</span>
              </template>
            </span>
          </div>
          <p v-if="group.run?.stopReason" class="faint" style="margin: 8px 0 0">
            {{ group.run.stopReason }}
          </p>

          <p v-if="loopBlockedReason" class="faint" style="margin: 10px 0 0">
            {{ loopBlockedReason }}
          </p>
        </template>
      </div>
    </div>

    <!-- ------------------------------------------------------- work order -->
    <div class="section">
      <h3>Work order ({{ group.queue.length }})</h3>
      <p class="dim" style="margin-top: 0">
        The unfinished tasks, ordered so nothing comes before what it depends on.
        This is the order <code class="mono">/work-group</code> works them in.
      </p>

      <div v-if="group.queue.length" class="panel">
        <ol class="group-queue">
          <li v-for="task in group.queue" :key="task.ref">
            <button class="task-chip" :title="task.title" @click="emit('openTask', task.ref)">
              <span class="mono">{{ task.ref }}</span>
              <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
              <span class="task-chip-title">{{ task.title }}</span>
            </button>
            <span v-if="blockedBy.get(task.ref)" class="faint">
              ⊘ waits for {{ blockedBy.get(task.ref)!.map((one) => one.ref).join(', ') }}
            </span>
          </li>
        </ol>
      </div>
      <p v-else class="empty">
        Nothing left to work. Everything in this group is dev complete or beyond.
      </p>

      <!-- Unfinished ones only. A closed dependency outside the group is work
           that already exists, and saying otherwise sends people looking for a
           blocker that is not there. -->
      <p v-if="group.outsideBlockers.length" class="banner warn">
        Tasks here wait on
        {{ group.outsideBlockers.map((one) => `${one.ref} (${STATUS_LABELS[one.status]})`).join(', ') }},
        which {{ group.outsideBlockers.length === 1 ? 'is' : 'are' }} not in this group —
        working the group alone will not clear
        {{ group.outsideBlockers.length === 1 ? 'it' : 'them' }}.
      </p>
    </div>

    <!-- -------------------------------------------------------------- run -->
    <div class="section">
      <h3>Work with an agent</h3>
      <div class="panel">
        <p class="dim" style="margin-top: 0">
          Works every task above in that order — branching each from
          <code class="mono">{{ group.branchName }}</code>, capturing before/after, and
          merging it back when it is done. It stops and reports rather than guessing
          if a task is blocked or a merge conflicts.
        </p>
        <div class="row">
          <code class="mono command">{{ command }}</code>
          <button :disabled="!!busy" @click="copyCommand">{{ copied ? 'Copied' : 'Copy' }}</button>
          <button
            class="primary"
            :disabled="!!busy"
            :title="emptyQueueReason ?? undefined"
            @click="launch = {
              command: 'work-group',
              target: group.ref,
              subjectKind: 'group',
              subjectRef: group.ref,
              subjectTitle: group.name,
              startBlockedReason: emptyQueueReason,
            }"
          >
            Work with Agent
          </button>
        </div>
        <p v-if="!group.queue.length" class="faint" style="margin: 12px 0 0">
          There is nothing left in this group for an agent to work.
        </p>
      </div>
    </div>

    <!-- ---------------------------------------------------------- sign off -->
    <div v-if="finished.length || outcomes" class="section">
      <h3>Sign off</h3>
      <div class="panel">
        <p class="dim" style="margin-top: 0">
          Takes the whole group at once. Closing verifies anything still at Dev
          Complete on the way, and cleans each task's visual checkpoint off disk.
          Tasks still being worked are left alone.
        </p>
        <div class="row" style="flex-wrap: wrap">
          <button
            :disabled="!!busy || !readyToVerify.length"
            :title="readyToVerify.length
              ? `Move ${readyToVerify.length} Dev Complete task(s) to Verified`
              : 'Nothing in this group is waiting to be verified.'"
            @click="signOff('verified')"
          >
            {{ busy === 'sign-off-verified' ? 'Verifying…' : `Verify all (${readyToVerify.length})` }}
          </button>
          <button
            class="primary"
            :disabled="!!busy || !readyToClose.length"
            :title="readyToClose.length
              ? `Verify and close ${readyToClose.length} task(s)`
              : 'Nothing in this group is ready to close.'"
            @click="signOff('closed')"
          >
            {{ busy === 'sign-off-closed' ? 'Closing…' : `Verify and close all (${readyToClose.length})` }}
          </button>
        </div>

        <p v-if="stillWorking.length" class="faint" style="margin: 12px 0 0">
          {{ stillWorking.length }} task(s) still in Backlog or In Progress — those stay
          where they are.
        </p>

        <!-- One task failing does not stop the others, so the result is a list
             rather than a single success or error. -->
        <template v-if="outcomes">
          <p class="faint" style="margin: 12px 0 6px">
            {{ outcomeSummary.moved }} moved ·
            {{ outcomeSummary.untouched }} left alone ·
            {{ outcomeSummary.failed }} failed
          </p>
          <ul class="signoff-outcomes">
            <li v-for="outcome in outcomes" :key="outcome.ref">
              <code class="mono">{{ outcome.ref }}</code>
              <span v-if="outcome.to" class="badge" :class="outcome.to">
                {{ STATUS_LABELS[outcome.from] }} → {{ STATUS_LABELS[outcome.to] }}
              </span>
              <span v-else class="faint">{{ STATUS_LABELS[outcome.from] }}</span>
              <span v-if="outcome.error" class="signoff-error">{{ outcome.error }}</span>
              <span v-else-if="outcome.skipped" class="faint">{{ outcome.skipped }}</span>
            </li>
          </ul>
        </template>
      </div>
    </div>

    <!-- ---------------------------------------------------------- finished -->
    <div v-if="finished.length" class="section">
      <h3>Finished ({{ finished.length }})</h3>
      <div class="panel row" style="flex-wrap: wrap">
        <button
          v-for="task in finished"
          :key="task.ref"
          class="task-chip"
          :title="registered.has(task.ref)
            ? `${task.ref} is merged into ${group.branchName}`
            : `${task.ref} is not on ${group.branchName} yet`"
          @click="emit('openTask', task.ref)"
        >
          <span class="mono">{{ task.ref }}</span>
          <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
          <span class="task-chip-title">{{ task.title }}</span>
          <!-- Registered by the merge, so its absence is real news: the task is
               finished but its work is not on the branch. -->
          <span :class="registered.has(task.ref) ? 'merged-yes' : 'merged-no'">
            {{ registered.has(task.ref) ? '✓ merged' : 'not merged' }}
          </span>
        </button>
      </div>
    </div>
  </section>
</template>
