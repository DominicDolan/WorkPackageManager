<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  STATUS_LABELS,
  type Comparison,
  type Priority,
  type Status,
  type TaskDetail,
} from '@shared/types';
import { api } from '../api';
import AgentRunDialog from './AgentRunDialog.vue';
import ComparisonCard from './ComparisonCard.vue';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps<{ task: TaskDetail; aioVrReady: boolean }>();
const emit = defineEmits<{
  changed: [TaskDetail];
  deleted: [string];
  openInvestigation: [string];
}>();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const editing = ref(false);
const noteText = ref('');
const working = ref(false);

const draft = ref({ title: '', description: '', priority: 'medium' as Priority, tags: '' });

watch(
  () => props.task.ref,
  () => {
    editing.value = false;
    error.value = null;
    noteText.value = '';
    working.value = false;
  },
);

/** An agent run moves the task through the workflow behind this view's back, so
 *  pick up whatever it did when the dialog is dismissed. */
async function agentDialogClosed(): Promise<void> {
  working.value = false;
  try {
    emit('changed', await api.getTask(props.task.ref));
  } catch {
    // The task may have been deleted by whatever ran; the list will say so.
  }
}

function beginEdit(): void {
  draft.value = {
    title: props.task.title,
    description: props.task.description,
    priority: props.task.priority,
    tags: props.task.tags.join(', '),
  };
  editing.value = true;
}

/** Wraps every mutation so one failure path handles the spinner and the error. */
async function run(label: string, action: () => Promise<TaskDetail>): Promise<void> {
  busy.value = label;
  error.value = null;
  try {
    emit('changed', await action());
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

const saveEdit = () =>
  run('save', () =>
    api.updateTask(props.task.ref, {
      title: draft.value.title,
      description: draft.value.description,
      priority: draft.value.priority,
      tags: draft.value.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    }),
  ).then(() => {
    if (!error.value) editing.value = false;
  });

const changeStatus = (status: Status) => run(status, () => api.setStatus(props.task.ref, status));
const closeTask = () => run('closed', () => api.closeTask(props.task.ref));

const capture = (phase: 'before' | 'after') =>
  run(`capture-${phase}`, () => api.capture(props.task.ref, phase));

const submitNote = () =>
  run('note', () => api.addNote(props.task.ref, noteText.value)).then(() => {
    if (!error.value) noteText.value = '';
  });

async function remove(): Promise<void> {
  if (!confirm(`Delete ${props.task.ref}? The checkpoint on disk is left alone.`)) return;

  busy.value = 'delete';
  try {
    await api.deleteTask(props.task.ref);
    emit('deleted', props.task.ref);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

/* ------------------------------------------------------------ checkpoints */

const beforeRun = computed(() =>
  [...props.task.runs].reverse().find((run) => run.phase === 'before') ?? null,
);
const afterRun = computed(() =>
  [...props.task.runs].reverse().find((run) => run.phase === 'after') ?? null,
);

/** What to render in the visual section: the after run once it exists (it
 *  carries both images), otherwise the before run's reference shots. */
const displayRun = computed(() => afterRun.value ?? beforeRun.value);

const changedCount = computed(
  () => afterRun.value?.comparisons.filter((c) => c.status === 'changed').length ?? 0,
);

/* ------------------------------------------- which screenshots are showing */

/** The scenarios worth looking at without being asked: a real pixel difference,
 *  or a capture that fell over. `unchanged` and `new-baseline` are noise once a
 *  run covers a dozen scenarios. */
const isInteresting = (comparison: Comparison) =>
  comparison.status === 'changed' || comparison.status === 'failed';

/** Open cards, by comparison id. Owned here rather than inside the card so the
 *  expand-all / collapse-all controls have something to write to. */
const openComparisons = ref(new Set<number>());

watch(
  displayRun,
  (run) => {
    openComparisons.value = new Set(
      (run?.comparisons ?? []).filter(isInteresting).map((c) => c.id),
    );
  },
  { immediate: true },
);

function setOpen(id: number, open: boolean): void {
  // Replaced rather than mutated — a Set mutation is not a reactive write.
  const next = new Set(openComparisons.value);
  if (open) {
    next.add(id);
  } else {
    next.delete(id);
  }
  openComparisons.value = next;
}

const allOpen = computed(
  () =>
    !!displayRun.value?.comparisons.length &&
    displayRun.value.comparisons.every((c) => openComparisons.value.has(c.id)),
);

function toggleAll(): void {
  openComparisons.value = allOpen.value
    ? new Set()
    : new Set((displayRun.value?.comparisons ?? []).map((c) => c.id));
}

const nextStatuses = computed<Status[]>(() => {
  switch (props.task.status) {
    case 'backlog':
      return ['in_progress'];
    case 'in_progress':
      return ['dev_complete', 'backlog'];
    case 'dev_complete':
      return ['verified', 'in_progress'];
    case 'verified':
      return ['closed', 'in_progress'];
    case 'closed':
      return [];
  }
});

const formatDate = (value: string) => new Date(value).toLocaleString();

const eventText = (event: TaskDetail['events'][number]): string => {
  if (event.type === 'status') {
    const from = event.fromStatus ? STATUS_LABELS[event.fromStatus] : '—';
    return `${from} → ${event.toStatus ? STATUS_LABELS[event.toStatus] : '—'}${
      event.note ? ` · ${event.note}` : ''
    }`;
  }
  return event.note ?? event.type;
};
</script>

<template>
  <section class="detail">
    <p v-if="error" class="banner">{{ error }}</p>

    <AgentRunDialog
      v-if="working"
      command="work-task"
      :target="task.ref"
      subject-kind="task"
      :subject-ref="task.ref"
      :subject-title="task.title"
      @close="agentDialogClosed"
    />

    <!-- ------------------------------------------------------------ header -->
    <template v-if="!editing">
      <div class="detail-header">
        <span class="mono dim">{{ task.ref }}</span>
        <h2>{{ task.title }}</h2>
      </div>

      <div class="row" style="flex-wrap: wrap; margin-bottom: 8px">
        <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
        <span :class="`priority-${task.priority}`">{{ task.priority }}</span>
        <span v-for="tag in task.tags" :key="tag" class="faint">#{{ tag }}</span>
        <button
          v-if="task.investigationRef"
          class="task-chip"
          :title="`Open ${task.investigationRef}`"
          @click="emit('openInvestigation', task.investigationRef!)"
        >
          <span class="faint">from</span>
          <span class="mono">{{ task.investigationRef }}</span>
        </button>
        <span class="spacer" />
        <button :disabled="!!busy" @click="beginEdit">Edit</button>
        <button class="danger" :disabled="!!busy" @click="remove">Delete</button>
      </div>

      <!-- A description filed by /plan-tasks carries the detail that saves the
           next agent repeating the investigation, and it is written in Markdown. -->
      <MarkdownBlock v-if="task.description" :source="task.description" />
      <p class="mono faint">Branch: {{ task.branchName ?? 'None (legacy completed task)' }}</p>

      <div class="row" style="flex-wrap: wrap; margin-top: 14px">
        <!-- /work-task drives the whole workflow — branch, before, change,
             after, done — so it sits with the buttons that do it by hand. -->
        <button class="primary" :disabled="!!busy" @click="working = true">Work with agent</button>
        <button
          v-for="status in nextStatuses"
          :key="status"
          :class="{ primary: status === 'dev_complete' || status === 'verified' }"
          :disabled="!!busy"
          @click="status === 'closed' ? closeTask() : changeStatus(status)"
        >
          {{ busy === status ? 'Working…' : status === 'closed' ? 'Clean checkpoint & close' : `Move to ${STATUS_LABELS[status]}` }}
        </button>
      </div>
    </template>

    <!-- -------------------------------------------------------------- edit -->
    <div v-else class="panel">
      <div class="field">
        <label for="edit-title">Title</label>
        <input id="edit-title" v-model="draft.title" />
      </div>
      <div class="field">
        <label for="edit-desc">Description</label>
        <textarea id="edit-desc" v-model="draft.description" />
      </div>
      <div class="row">
        <div class="field" style="flex: 1">
          <label for="edit-priority">Priority</label>
          <select id="edit-priority" v-model="draft.priority">
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </div>
        <div class="field" style="flex: 2">
          <label for="edit-tags">Tags (comma separated)</label>
          <input id="edit-tags" v-model="draft.tags" />
        </div>
      </div>
      <div class="row">
        <button class="primary" :disabled="busy === 'save'" @click="saveEdit">
          {{ busy === 'save' ? 'Saving…' : 'Save' }}
        </button>
        <button :disabled="!!busy" @click="editing = false">Cancel</button>
      </div>
    </div>

    <!-- ------------------------------------------------------- checkpoints -->
    <div class="section">
      <h3>Visual checkpoint</h3>

      <p v-if="!aioVrReady" class="banner warn">
        The aio-vr CLI is not on PATH, so captures cannot run from here. Existing
        screenshots are still shown.
      </p>

      <div class="row" style="flex-wrap: wrap; margin-bottom: 16px">
        <code class="mono faint">{{ task.checkpointName }}</code>
        <span class="spacer" />
        <button :disabled="!!busy || !aioVrReady" @click="capture('before')">
          {{ busy === 'capture-before' ? 'Capturing…' : 'Capture before' }}
        </button>
        <button :disabled="!!busy || !aioVrReady || !beforeRun" @click="capture('after')">
          {{ busy === 'capture-after' ? 'Comparing…' : 'Capture after' }}
        </button>
      </div>

      <p v-if="busy?.startsWith('capture')" class="dim">
        Driving a real browser through every scenario — this takes a while.
      </p>

      <template v-if="displayRun">
        <div class="row" style="flex-wrap: wrap; margin-bottom: 12px">
          <p class="faint" style="margin: 0">
            <template v-if="afterRun">
              Compared {{ formatDate(afterRun.createdAt) }} against the checkpoint taken
              {{ beforeRun ? formatDate(beforeRun.createdAt) : 'earlier' }}.
              <strong v-if="changedCount">{{ changedCount }} scenario(s) changed.</strong>
              <strong v-else>No visual differences.</strong>
            </template>
            <template v-else>
              Reference state captured {{ formatDate(displayRun.createdAt) }}. Make your
              change, then capture "after" to see the comparison.
            </template>
          </p>
          <span class="spacer" />
          <button v-if="displayRun.comparisons.length > 1" @click="toggleAll">
            {{ allOpen ? 'Collapse all' : 'Expand all' }}
          </button>
        </div>

        <ComparisonCard
          v-for="comparison in displayRun.comparisons"
          :key="comparison.id"
          :comparison="comparison"
          :open="openComparisons.has(comparison.id)"
          @update:open="setOpen(comparison.id, $event)"
        />
      </template>

      <p v-else class="empty">
        Nothing captured yet. Take a "before" checkpoint prior to making your change.
      </p>
    </div>

    <!-- ----------------------------------------------------------- history -->
    <div class="section">
      <h3>History</h3>
      <div class="panel">
        <div class="field">
          <label for="note">Add a note</label>
          <div class="row">
            <input
              id="note"
              v-model="noteText"
              placeholder="What happened?"
              @keyup.enter="noteText && submitNote()"
            />
            <button :disabled="!noteText || !!busy" @click="submitNote">Add</button>
          </div>
        </div>

        <ul class="events">
          <li v-for="event in [...task.events].reverse()" :key="event.id">
            <time>{{ formatDate(event.createdAt) }}</time>
            <span>{{ eventText(event) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
