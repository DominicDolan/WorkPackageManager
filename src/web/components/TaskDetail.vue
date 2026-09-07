<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  DEFAULT_ESTIMATE_UNITS,
  MAX_ESTIMATE_UNITS,
  MODEL_TIERS,
  STATUS_LABELS,
  satisfiesDependency,
  type Comparison,
  type ModelTier,
  type Priority,
  type Status,
  type Task,
  type TaskDetail,
  type TaskGroupSummary,
} from '@shared/types';
import { api, taskAssetUrl } from '../api';
import AgentRunDialog from './AgentRunDialog.vue';
import ComparisonCard from './ComparisonCard.vue';
import ImageLightbox, { type LightboxImage } from './ImageLightbox.vue';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps<{
  task: TaskDetail;
  aioVrReady: boolean;
  /** The task list as the sidebar has it — what the dependency picker offers,
   *  and how a blocker's ref becomes a title and a status. */
  allTasks: Task[];
  /** Every group there is — what the group picker offers. */
  groups: TaskGroupSummary[];
}>();
const emit = defineEmits<{
  changed: [TaskDetail];
  deleted: [string];
  openInvestigation: [string];
  openTask: [string];
}>();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const editing = ref(false);
const noteText = ref('');
const working = ref(false);

const draft = ref({
  title: '',
  description: '',
  priority: 'medium' as Priority,
  recommendedTier: null as ModelTier | null,
  tags: '',
  estimateUnits: DEFAULT_ESTIMATE_UNITS,
});

watch(
  () => props.task.ref,
  () => {
    editing.value = false;
    error.value = null;
    noteText.value = '';
    working.value = false;
    addingBlocker.value = '';
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
    recommendedTier: props.task.recommendedTier,
    tags: props.task.tags.join(', '),
    estimateUnits: props.task.estimateUnits ?? DEFAULT_ESTIMATE_UNITS,
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
      recommendedTier: draft.value.recommendedTier,
      tags: draft.value.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      estimateUnits: draft.value.estimateUnits,
    }),
  ).then(() => {
    if (!error.value) editing.value = false;
  });

/** A merge conflict on the way into Dev Complete is a separate line of news
 *  from a failed request: the status moved, and the branch needs attention. */
const mergeNotice = ref<string | null>(null);

const changeStatus = (status: Status) =>
  run(status, async () => {
    mergeNotice.value = null;
    const result = await api.setStatus(props.task.ref, status);
    mergeNotice.value = result.mergeError;
    return result.task;
  });

const mergeIntoGroupBranch = () =>
  run('merge', async () => {
    mergeNotice.value = null;
    return api.mergeIntoGroupBranch(props.task.ref);
  });

/* ----------------------------------------------------------------- group */

const group = computed(
  () => props.groups.find((one) => one.ref.toLowerCase() === props.task.groupRef?.toLowerCase()) ?? null,
);

/** Moving a task into a group also moves it beside that group's other tasks in
 *  the queue — the same thing dragging it there does, so the list does not have
 *  to be reread to find out where it went. */
const setGroup = (event: Event) => {
  const chosen = (event.target as HTMLSelectElement).value;
  return run('group', () =>
    api.setTaskGroup(props.task.ref, chosen || null).then((result) => result.task),
  );
};
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

/* ----------------------------------------------------------- dependencies */

const addingBlocker = ref('');

const taskByRef = computed(() => new Map(props.allTasks.map((task) => [task.ref, task])));

/** A blocker as much as is known about it. A ref with no task behind it is one
 *  the sidebar is not currently carrying — a closed task, most often — so it is
 *  shown as itself rather than dropped. */
interface Link {
  ref: string;
  task: Task | null;
  met: boolean;
}

const toLink = (ref: string): Link => {
  const task = taskByRef.value.get(ref) ?? null;
  return { ref, task, met: task ? satisfiesDependency(task.status) : true };
};

const blockers = computed(() => props.task.dependsOn.map(toLink));
const blocking = computed(() => props.task.blocks.map(toLink));
const unmet = computed(() => blockers.value.filter((link) => !link.met));

/** Everything this task could newly wait for: not itself, not already a
 *  blocker, and not something already waiting on it — the server refuses a
 *  cycle, but there is no reason to offer one. */
const blockerOptions = computed(() =>
  props.allTasks.filter(
    (task) =>
      task.ref !== props.task.ref &&
      !props.task.dependsOn.includes(task.ref) &&
      !props.task.blocks.includes(task.ref),
  ),
);

const addBlocker = () =>
  run('dependency', () => api.addDependencies(props.task.ref, [addingBlocker.value])).then(() => {
    if (!error.value) addingBlocker.value = '';
  });

const removeBlocker = (blockerRef: string) =>
  run(`dependency-${blockerRef}`, () => api.removeDependency(props.task.ref, blockerRef));

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

/* ------------------------------------------------------------ attachments */

const dragging = ref(false);

async function uploadFiles(files: File[]): Promise<{ name: string }[]> {
  if (!files.length) return [];
  busy.value = 'upload';
  error.value = null;
  try {
    const result = await api.uploadTaskAttachments(props.task.ref, files);
    emit('changed', result.task);
    return result.added;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    return [];
  } finally {
    busy.value = null;
  }
}

/** Drop the markdown image link where the caret is, so a pasted screenshot
 *  lands in the paragraph being written rather than at the end. */
function insertAtCursor(text: string): void {
  const field = descriptionEditor.value;
  if (!field) {
    draft.value.description = `${draft.value.description.replace(/\s+$/, '')}\n\n${text}\n`;
    return;
  }

  const start = field.selectionStart;
  const end = field.selectionEnd;
  const before = draft.value.description.slice(0, start);
  const after = draft.value.description.slice(end);
  const padded = `${before}${before && !before.endsWith('\n') ? '\n\n' : ''}${text}\n${after}`;
  draft.value.description = padded;

  const caret = padded.length - after.length;
  requestAnimationFrame(() => {
    field.focus();
    field.setSelectionRange(caret, caret);
  });
}

/** Upload files pasted or dropped into the description, and link them into it
 *  at the caret — mirroring how a note's editor attaches an image. */
async function uploadIntoDescription(files: File[]): Promise<void> {
  if (!files.length) return;
  const added = await uploadFiles(files);
  const markdown = added.map((one) => `![${one.name}](${taskAssetUrl(props.task.ref, one.name)})`);
  if (markdown.length) insertAtCursor(markdown.join('\n'));
}

const descriptionEditor = ref<HTMLTextAreaElement | null>(null);

function onDescriptionPaste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  // Only take over the paste when it is actually a file: pasted text must keep
  // the browser's own behaviour, caret and undo history included.
  event.preventDefault();
  void uploadIntoDescription(files);
}

function onDescriptionDrop(event: DragEvent): void {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  // Stopped so the section-level drop handler below does not also fire for the
  // same drop — that one attaches the file without linking it into the text.
  event.preventDefault();
  event.stopPropagation();
  void uploadIntoDescription(files);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  void uploadFiles(files);
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  void uploadFiles([...(input.files ?? [])]).then(() => (input.value = ''));
}

async function removeAttachment(name: string): Promise<void> {
  if (!confirm(`Delete the attachment '${name}'?`)) return;
  await run(`attachment-${name}`, () => api.deleteTaskAttachment(props.task.ref, name));
}

/** Every image attached to this task, in the order the list shows them, so the
 *  viewer can step through the set from whichever one was clicked. */
const gallery = computed<LightboxImage[]>(() =>
  props.task.attachments
    .filter((attachment) => attachment.isImage)
    .map((attachment) => ({ src: taskAssetUrl(props.task.ref, attachment.name), name: attachment.name })),
);

const viewing = ref<{ images: LightboxImage[]; index: number } | null>(null);
watch(() => props.task.ref, () => (viewing.value = null));

function viewAttachment(name: string): void {
  const index = gallery.value.findIndex((image) => image.name === name);
  if (index !== -1) viewing.value = { images: gallery.value, index };
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

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
  <section class="detail" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop="onDrop">
    <p v-if="error" class="banner">{{ error }}</p>
    <!-- The status change succeeded and the merge did not, so this is its own
         line rather than the error banner. -->
    <p v-if="mergeNotice" class="banner">
      {{ mergeNotice }}
      <button :disabled="!!busy" @click="mergeIntoGroupBranch">
        {{ busy === 'merge' ? 'Merging…' : 'Merge again' }}
      </button>
    </p>

    <AgentRunDialog
      v-if="working"
      command="work-task"
      :target="task.ref"
      subject-kind="task"
      :subject-ref="task.ref"
      :subject-title="task.title"
      :recommended-tier="task.recommendedTier"
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
        <span v-if="task.recommendedTier" class="faint" title="What an investigation judged this task needs">
          tier: {{ task.recommendedTier }}
        </span>
        <!-- The plan's unit of time, shown here so the number the Plan view
             schedules on is visible from the task itself. -->
        <span class="faint" title="Estimate, in plan units">
          {{ task.estimateUnits }} unit{{ task.estimateUnits === 1 ? '' : 's' }}
        </span>
        <span v-for="tag in task.tags" :key="tag" class="faint">#{{ tag }}</span>
        <!-- Editable in place rather than behind Edit: which bundle a task
             belongs to changes far more often than its title does. -->
        <label class="detail-group" :title="group?.description || 'The group this task is in'">
          <span
            class="group-dot"
            :style="{ background: group?.color ?? 'var(--text-faint)' }"
            aria-hidden="true"
          />
          <select
            aria-label="Group"
            :value="task.groupRef ?? ''"
            :disabled="!!busy"
            @change="setGroup"
          >
            <option value="">No group</option>
            <option v-for="one in groups" :key="one.ref" :value="one.ref">{{ one.name }}</option>
          </select>
        </label>
        <!-- Where this task's branch is cut from, and where Dev Complete merges
             it back to — worth seeing without opening the group. -->
        <span v-if="group" class="mono faint" :title="`${group.ref}'s branch`">
          → {{ group.branchName }}
        </span>
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

      <!-- Stated, not enforced: the buttons below stay live, because deciding
           to start something anyway is a judgement call, not a mistake. -->
      <p v-if="unmet.length" class="banner warn">
        Waiting on {{ unmet.map((link) => link.ref).join(', ') }} — not finished yet.
      </p>

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
        <textarea
          id="edit-desc"
          ref="descriptionEditor"
          v-model="draft.description"
          placeholder="Markdown. Paste or drop an image to attach it."
          @paste="onDescriptionPaste"
          @drop="onDescriptionDrop"
        />
        <p v-if="busy === 'upload'" class="faint" style="margin: 4px 0 0">Uploading…</p>
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
        <div class="field" style="flex: 1">
          <label for="edit-tier">Tier <span class="faint">(model recommendation)</span></label>
          <select
            id="edit-tier"
            :value="draft.recommendedTier ?? ''"
            @change="draft.recommendedTier = (($event.target as HTMLSelectElement).value || null) as ModelTier | null"
          >
            <option value="">none</option>
            <option v-for="tier in MODEL_TIERS" :key="tier" :value="tier">{{ tier }}</option>
          </select>
        </div>
        <div class="field" style="flex: 1">
          <label for="edit-units">Units <span class="faint">(plan length)</span></label>
          <input
            id="edit-units"
            v-model.number="draft.estimateUnits"
            type="number"
            min="1"
            :max="MAX_ESTIMATE_UNITS"
          />
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

    <!-- ------------------------------------------------------ dependencies -->
    <div class="section">
      <h3>Dependencies</h3>

      <div class="panel">
        <div class="field">
          <label for="add-blocker">This task waits for</label>
          <div class="row">
            <select id="add-blocker" v-model="addingBlocker" style="flex: 1">
              <option value="">Choose a task…</option>
              <option v-for="option in blockerOptions" :key="option.ref" :value="option.ref">
                {{ option.ref }} — {{ option.title }}
              </option>
            </select>
            <button :disabled="!addingBlocker || !!busy" @click="addBlocker">
              {{ busy === 'dependency' ? 'Adding…' : 'Add' }}
            </button>
          </div>
        </div>

        <ul v-if="blockers.length" class="dependency-list">
          <li v-for="link in blockers" :key="link.ref">
            <button class="task-chip" :title="`Open ${link.ref}`" @click="emit('openTask', link.ref)">
              <span class="mono">{{ link.ref }}</span>
              <span v-if="link.task" class="badge" :class="link.task.status">
                {{ STATUS_LABELS[link.task.status] }}
              </span>
              <span class="task-chip-title">{{ link.task?.title ?? 'not in the current list' }}</span>
            </button>
            <span class="spacer" />
            <span :class="link.met ? 'dependency-met' : 'dependency-unmet'">
              {{ link.met ? '✓ done' : '⊘ waiting' }}
            </span>
            <button
              class="danger"
              :disabled="!!busy"
              :title="`Stop waiting for ${link.ref}`"
              @click="removeBlocker(link.ref)"
            >
              {{ busy === `dependency-${link.ref}` ? '…' : 'Remove' }}
            </button>
          </li>
        </ul>
        <p v-else class="faint">Nothing is holding this task up.</p>
      </div>

      <template v-if="blocking.length">
        <p class="faint" style="margin: 14px 0 6px">Waiting on this task</p>
        <div class="row" style="flex-wrap: wrap">
          <button
            v-for="link in blocking"
            :key="link.ref"
            class="task-chip"
            :title="`Open ${link.ref}`"
            @click="emit('openTask', link.ref)"
          >
            <span class="mono">{{ link.ref }}</span>
            <span class="task-chip-title">{{ link.task?.title ?? 'not in the current list' }}</span>
          </button>
        </div>
      </template>
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

    <!-- --------------------------------------------------------- attachments -->
    <div class="section" :class="{ dropping: dragging }">
      <h3>Attachments{{ task.attachments.length ? ` (${task.attachments.length})` : '' }}</h3>

      <div class="panel">
        <p class="faint" style="margin: 0 0 10px">
          Drop a screenshot here, or attach one below. Any agent working this task can read
          these files directly off disk.
        </p>
        <div class="row">
          <label class="attach-button">
            <input type="file" multiple hidden accept="image/*" @change="onPick" />
            <span>{{ busy === 'upload' ? 'Uploading…' : 'Attach files' }}</span>
          </label>
        </div>

        <div v-if="task.attachments.length" class="attachment-grid" style="margin-top: 12px">
          <figure v-for="attachment in task.attachments" :key="attachment.path" class="attachment">
            <button
              v-if="attachment.isImage"
              class="attachment-open"
              :title="`View ${attachment.name}`"
              @click="viewAttachment(attachment.name)"
            >
              <img :src="taskAssetUrl(task.ref, attachment.name)" :alt="attachment.name" />
            </button>
            <a v-else :href="taskAssetUrl(task.ref, attachment.name)" target="_blank" rel="noreferrer noopener">
              <span class="attachment-file" aria-hidden="true">📎</span>
            </a>
            <figcaption>
              <span class="mono">{{ attachment.name }}</span>
              <span class="faint">{{ formatSize(attachment.size) }}</span>
              <button
                class="danger"
                :disabled="!!busy"
                @click="removeAttachment(attachment.name)"
              >
                {{ busy === `attachment-${attachment.name}` ? '…' : 'Remove' }}
              </button>
            </figcaption>
          </figure>
        </div>
      </div>
    </div>

    <ImageLightbox
      v-if="viewing"
      :images="viewing.images"
      :index="viewing.index"
      @update:index="viewing.index = $event"
      @close="viewing = null"
    />

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
