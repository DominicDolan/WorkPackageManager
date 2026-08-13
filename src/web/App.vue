<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  INVESTIGATION_STATUS_LABELS,
  ISSUE_SOURCE_LABELS,
  STATUS_LABELS,
  STATUSES,
  type CombinedBranchDetail,
  type Investigation,
  type InvestigationDetail as InvestigationDetailModel,
  type IssueDetail as IssueDetailModel,
  type IssueState,
  type IssueSummary,
  type Note,
  type NoteSummary,
  type NotesWorkspaceInfo,
  type Priority,
  type Status,
  type Task,
  type TaskDetail as TaskDetailModel,
} from '@shared/types';
import type { ChangeChannel } from '@shared/types';
import { api, type Meta } from './api';
import BranchDetail from './components/BranchDetail.vue';
import CombineBranches from './components/CombineBranches.vue';
import InvestigationDetail from './components/InvestigationDetail.vue';
import IssueCards from './components/IssueCards.vue';
import IssueDetail from './components/IssueDetail.vue';
import NoteDetail from './components/NoteDetail.vue';
import TaskDetail from './components/TaskDetail.vue';
import { useLiveUpdates } from './useLiveUpdates';
import { useLocation } from './useLocation';

/** Which rail section is showing. */
type View = 'investigations' | 'tasks' | 'branches' | 'combine' | 'notes' | 'issues';

const tasks = ref<Task[]>([]);
const selected = ref<TaskDetailModel | null>(null);
const meta = ref<Meta | null>(null);
const filter = ref<Status | 'all'>('all');
const error = ref<string | null>(null);
const loading = ref(true);
const creating = ref(false);
const selectedRefs = ref(new Set<string>());
const combining = ref(false);
const combineBranchName = ref('');
const closeCombinedTasks = ref(true);

const { location, navigate } = useLocation();
const view = ref<View>('tasks');

const VIEW_PATHS: Record<View, string> = {
  investigations: '/investigations',
  tasks: '/tasks',
  branches: '/branches',
  combine: '/combine',
  notes: '/notes',
  issues: '/issues',
};

function viewForPath(path: string): View {
  return (Object.entries(VIEW_PATHS).find(([, value]) => value === path)?.[0] as View | undefined) ?? 'tasks';
}

const investigations = ref<Investigation[]>([]);
const selectedInvestigation = ref<InvestigationDetailModel | null>(null);
const investigationsLoading = ref(false);
const creatingInvestigation = ref(false);
const newInvestigation = ref({ title: '', brief: '' });

const notes = ref<NoteSummary[]>([]);
const noteFolders = ref<string[]>([]);
const noteTags = ref<string[]>([]);
const notesWorkspace = ref<NotesWorkspaceInfo | null>(null);
const selectedNote = ref<Note | null>(null);
const notesLoading = ref(false);
const notesFilter = ref({ q: '', tag: '', folder: '' });
const creatingNote = ref(false);
const newNote = ref({ title: '', folder: '' });

const issues = ref<IssueSummary[]>([]);
const issueFacets = ref<{ sources: { source: string; count: number }[]; labels: string[]; total: number }>({
  sources: [],
  labels: [],
  total: 0,
});
const selectedIssue = ref<IssueDetailModel | null>(null);
const issuesLoading = ref(false);
const issuesFilter = ref({ q: '', state: 'all' as IssueState | 'all', source: '', label: '' });

const branches = ref<CombinedBranchDetail[]>([]);
const selectedBranch = ref<string | null>(null);
const branchesLoading = ref(false);

/** Investigations still waiting to be run — the only count worth a badge. */
const openInvestigations = computed(
  () => investigations.value.filter((one) => one.status !== 'complete').length,
);

const currentBranch = computed(
  () => branches.value.find((branch) => branch.branchName === selectedBranch.value) ?? null,
);

const newTask = ref({ title: '', description: '', priority: 'medium' as Priority, tags: '', branchName: '' });

const visibleTasks = computed(() =>
  filter.value === 'all' ? tasks.value : tasks.value.filter((task) => task.status === filter.value),
);

const counts = computed(() => {
  const result: Record<string, number> = { all: tasks.value.length };
  for (const status of STATUSES) {
    result[status] = tasks.value.filter((task) => task.status === status).length;
  }
  return result;
});

async function refreshList(): Promise<void> {
  tasks.value = await api.listTasks();
}

async function select(ref_: string): Promise<void> {
  error.value = null;
  try {
    selected.value = await api.getTask(ref_);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

/** A detail-pane mutation changed the task; keep the list column in step. */
async function onChanged(task: TaskDetailModel): Promise<void> {
  selected.value = task;
  await refreshList();
}

async function onDeleted(ref_: string): Promise<void> {
  selected.value = null;
  tasks.value = tasks.value.filter((task) => task.ref !== ref_);
}

function toggleTask(ref_: string): void {
  const next = new Set(selectedRefs.value);
  if (next.has(ref_)) next.delete(ref_);
  else next.add(ref_);
  selectedRefs.value = next;
}

/* ------------------------------------------------------------ list order */

/** The row being dragged, and the row the pointer is currently over. */
const draggingRef = ref<string | null>(null);
const dropTargetRef = ref<string | null>(null);
/** Whether the drop lands below the target row rather than above it. */
const dropBelow = ref(false);

/**
 * Push a new order for the visible rows.
 *
 * Only the visible rows move: their new sequence is threaded back through the
 * full list in place, leaving rows the filter hides exactly where they are.
 * That mirrors what the server does with the positions, so the optimistic
 * update and the reload agree.
 */
async function applyOrder(orderedVisibleRefs: string[]): Promise<void> {
  const moving = new Set(orderedVisibleRefs);
  const byRef = new Map(tasks.value.map((task) => [task.ref, task]));
  let next = 0;

  tasks.value = tasks.value.map((task) =>
    moving.has(task.ref) ? byRef.get(orderedVisibleRefs[next++]!)! : task,
  );

  try {
    tasks.value = await api.reorderTasks(orderedVisibleRefs);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    await refreshList();
  }
}

/** Move one row `delta` places within the visible list. */
async function moveBy(ref_: string, delta: number): Promise<void> {
  const order = visibleTasks.value.map((task) => task.ref);
  const from = order.indexOf(ref_);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return;

  order.splice(to, 0, ...order.splice(from, 1));
  await applyOrder(order);
}

function onDragStart(ref_: string, event: DragEvent): void {
  draggingRef.value = ref_;
  event.dataTransfer?.setData('text/plain', ref_);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(ref_: string, event: DragEvent): void {
  if (!draggingRef.value || draggingRef.value === ref_) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

  // Which half of the row the pointer is in decides whether the dragged task
  // lands above or below it — without that, dropping onto the last row can
  // never reach the bottom of the list.
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropTargetRef.value = ref_;
  dropBelow.value = event.clientY > box.top + box.height / 2;
}

/** `dragleave` also fires when the pointer crosses onto one of the row's own
 *  children, which would blink the insertion marker off on every word it passes
 *  over. Only a leave that lands outside the row is a real leave. */
function onDragLeave(ref_: string, event: DragEvent): void {
  const row = event.currentTarget as HTMLElement;
  const entering = event.relatedTarget as Node | null;
  if (entering && row.contains(entering)) return;
  if (dropTargetRef.value === ref_) dropTargetRef.value = null;
}

async function onDrop(ref_: string): Promise<void> {
  const moved = draggingRef.value;
  const below = dropBelow.value;
  endDrag();
  if (!moved || moved === ref_) return;

  const order = visibleTasks.value.map((task) => task.ref);
  const from = order.indexOf(moved);
  if (from === -1) return;

  order.splice(from, 1);
  const anchor = order.indexOf(ref_);
  order.splice(anchor + (below ? 1 : 0), 0, moved);
  await applyOrder(order);
}

function endDrag(): void {
  draggingRef.value = null;
  dropTargetRef.value = null;
}

/* --------------------------------------------------------- investigations */

async function refreshInvestigations(): Promise<void> {
  investigations.value = await api.listInvestigations();
}

async function selectInvestigation(ref_: string): Promise<void> {
  error.value = null;
  try {
    selectedInvestigation.value = await api.getInvestigation(ref_);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function onInvestigationChanged(investigation: InvestigationDetailModel): Promise<void> {
  selectedInvestigation.value = investigation;
  await refreshInvestigations();
}

async function onInvestigationDeleted(ref_: string): Promise<void> {
  selectedInvestigation.value = null;
  investigations.value = investigations.value.filter((one) => one.ref !== ref_);
  // Tasks it filed survive the delete, but their link is gone.
  await refreshList();
}

async function createInvestigation(): Promise<void> {
  if (!newInvestigation.value.title.trim()) return;

  try {
    const created = await api.createInvestigation({
      title: newInvestigation.value.title,
      brief: newInvestigation.value.brief,
    });

    creatingInvestigation.value = false;
    newInvestigation.value = { title: '', brief: '' };
    await refreshInvestigations();
    selectedInvestigation.value = created;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

/** Jump from a task back to the investigation that filed it. */
async function openInvestigation(ref_: string): Promise<void> {
  navigate(VIEW_PATHS.investigations);
  view.value = 'investigations';
  await refreshInvestigations();
  await selectInvestigation(ref_);
}

/* ----------------------------------------------------------------- notes */

/**
 * Notes come off the file system, not the database, so the list is re-read
 * rather than patched: the folder is a Git repository somebody may have pulled,
 * edited in another editor or written to with `tasks notes` since this tab was
 * opened, and there is no event to tell us they did.
 */
async function refreshNotes(): Promise<void> {
  const listing = await api.listNotes({
    q: notesFilter.value.q || undefined,
    tag: notesFilter.value.tag || undefined,
    folder: notesFilter.value.folder || undefined,
  });
  notes.value = listing.notes;
  noteFolders.value = listing.folders;
  noteTags.value = listing.tags;
  notesWorkspace.value = listing.workspace;
}

async function selectNote(path: string): Promise<void> {
  error.value = null;
  try {
    selectedNote.value = await api.getNote(path);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

/** A saved note can have changed its title, tags or modified time, all of which
 *  the list column shows — and its Git state moves with every write. */
async function onNoteChanged(note: Note): Promise<void> {
  selectedNote.value = note;
  await refreshNotes();
}

async function onNoteDeleted(path: string): Promise<void> {
  selectedNote.value = null;
  notes.value = notes.value.filter((note) => note.path !== path);
  await refreshNotes();
  if (notes.value.length) await selectNote(notes.value[0]!.path);
}

async function createNote(): Promise<void> {
  if (!newNote.value.title.trim()) return;

  try {
    const created = await api.createNote({
      title: newNote.value.title,
      folder: newNote.value.folder.trim() || undefined,
    });
    creatingNote.value = false;
    newNote.value = { title: '', folder: '' };
    await refreshNotes();
    selectedNote.value = created;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function syncNotes(push: boolean): Promise<void> {
  notesLoading.value = true;
  error.value = null;
  try {
    await api.syncNotes(push);
    await refreshNotes();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    notesLoading.value = false;
  }
}

/** Creates the folder and `git init`s it — the one action available when the
 *  configured notes folder is not there yet. */
async function initNotes(): Promise<void> {
  notesLoading.value = true;
  error.value = null;
  try {
    notesWorkspace.value = await api.initNotes();
    await refreshNotes();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    notesLoading.value = false;
  }
}

let notesSearchTimer: ReturnType<typeof setTimeout> | undefined;

/** Search runs on the server (it reads the files), so it is debounced rather
 *  than fired on every keystroke. */
watch(
  () => ({ ...notesFilter.value }),
  () => {
    clearTimeout(notesSearchTimer);
    notesSearchTimer = setTimeout(() => {
      void refreshNotes().catch((caught: unknown) => {
        error.value = caught instanceof Error ? caught.message : String(caught);
      });
    }, 200);
  },
  { deep: true },
);

/* ---------------------------------------------------------------- issues */

/**
 * Issues are JSON files in the notes folder, fetched by something else — so
 * like notes they are re-read rather than cached, and there is nothing here
 * that writes back.
 */
async function refreshIssues(): Promise<void> {
  const listing = await api.listIssues({
    q: issuesFilter.value.q || undefined,
    state: issuesFilter.value.state === 'all' ? undefined : issuesFilter.value.state,
    source: issuesFilter.value.source || undefined,
    label: issuesFilter.value.label || undefined,
  });
  issues.value = listing.issues;
  issueFacets.value = listing.facets;
  notesWorkspace.value = listing.notes;
}

async function openIssue(id: string): Promise<void> {
  error.value = null;
  try {
    selectedIssue.value = await api.getIssue(id);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

const issuesFiltered = computed(
  () =>
    Boolean(issuesFilter.value.q || issuesFilter.value.source || issuesFilter.value.label) ||
    issuesFilter.value.state !== 'all',
);

let issuesSearchTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => ({ ...issuesFilter.value }),
  () => {
    clearTimeout(issuesSearchTimer);
    issuesSearchTimer = setTimeout(() => {
      void refreshIssues().catch((caught: unknown) => {
        error.value = caught instanceof Error ? caught.message : String(caught);
      });
    }, 200);
  },
  { deep: true },
);

/* -------------------------------------------------------------- branches */

async function refreshBranches(): Promise<void> {
  branchesLoading.value = true;
  try {
    const result = await api.listBranches();
    branches.value = result.branches;
    if (!branches.value.some((branch) => branch.branchName === selectedBranch.value)) {
      selectedBranch.value = branches.value[0]?.branchName ?? null;
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    branchesLoading.value = false;
  }
}

/** Splice the server's version of one branch back into the list, leaving the
 *  other rows (each carrying a fresh Git read) untouched. */
function onBranchChanged(branch: CombinedBranchDetail): void {
  branches.value = branches.value.map((existing) =>
    existing.branchName === branch.branchName ? branch : existing,
  );
  selectedBranch.value = branch.branchName;
}

function onBranchForgotten(name: string): void {
  branches.value = branches.value.filter((branch) => branch.branchName !== name);
  selectedBranch.value = branches.value[0]?.branchName ?? null;
}

async function showView(next: View): Promise<void> {
  view.value = next;
  error.value = null;
  // Git state is read per request, so a revisit always reflects the working
  // tree as it is now rather than as it was when the tab was last open.
  if (next === 'branches') await refreshBranches();

  // The issue files are refreshed by whatever fetches them, so every visit is a
  // fresh read — and the board opens on the board, not on whatever was last
  // clicked into.
  if (next === 'issues') {
    issuesLoading.value = true;
    selectedIssue.value = null;
    try {
      await refreshIssues();
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      issuesLoading.value = false;
    }
  }

  // Same reasoning for notes, which live on disk and change behind this tab's
  // back whenever the CLI, an agent or a `git pull` touches the folder.
  if (next === 'notes') {
    notesLoading.value = true;
    try {
      await refreshNotes();
      const previous = selectedNote.value?.path;
      const current = notes.value.some((note) => note.path === previous) ? previous : notes.value[0]?.path;
      if (current) await selectNote(current);
      else selectedNote.value = null;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      notesLoading.value = false;
    }
  }

  // An agent may have run an investigation since this tab was last open, so
  // re-read rather than trusting what is on screen.
  if (next === 'investigations') {
    investigationsLoading.value = true;
    try {
      await refreshInvestigations();
      const previous = selectedInvestigation.value?.ref;
      const current = investigations.value.some((one) => one.ref === previous)
        ? previous
        : investigations.value[0]?.ref;
      if (current) await selectInvestigation(current);
      else selectedInvestigation.value = null;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      investigationsLoading.value = false;
    }
  }
}

/** Jump from a branch's task chip back to that task. */
async function openTask(ref_: string): Promise<void> {
  navigate(VIEW_PATHS.tasks);
  view.value = 'tasks';
  await select(ref_);
}

function navigateTo(next: View): void {
  navigate(VIEW_PATHS[next]);
  void showView(next);
}

function combineSelected(): void {
  if (selectedRefs.value.size < 1) return;
  error.value = null;
  navigateTo('combine');
}

async function combineStarted(branchName: string): Promise<void> {
  selectedRefs.value = new Set();
  combineBranchName.value = '';
  closeCombinedTasks.value = true;
  selectedBranch.value = branchName;
  await refreshList();
  navigate(VIEW_PATHS.branches);
  await showView('branches');
}

async function continueCombine(branchName: string): Promise<void> {
  combining.value = true;
  error.value = null;
  try {
    await api.continueCombine(branchName);
    await refreshList();
    await refreshBranches();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    await refreshBranches();
  } finally {
    combining.value = false;
  }
}

async function createTask(): Promise<void> {
  if (!newTask.value.title.trim()) return;

  try {
    const created = await api.createTask({
      title: newTask.value.title,
      description: newTask.value.description,
      priority: newTask.value.priority,
      tags: newTask.value.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      branchName: newTask.value.branchName.trim() || undefined,
    });

    creating.value = false;
    newTask.value = { title: '', description: '', priority: 'medium', tags: '', branchName: '' }; 
    await refreshList();
    await select(created.ref);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

/* ---------------------------------------------------------- live updates */

/**
 * Something else wrote to the workspace — the CLI, an agent, a `git pull`.
 *
 * Reloads what is actually on screen rather than everything: the two list
 * columns that are visible from anywhere, whatever record is selected, and the
 * current view's own data. The detail components each keep unsaved typing over
 * an incoming version (see the brief, the note body and the PR description), so
 * this cannot take an edit out from under anyone.
 */
async function refreshFromChange(channel: ChangeChannel): Promise<void> {
  // A drag is a reorder the server has not been told about yet; reloading the
  // list underneath it would put every row back where it started.
  if (draggingRef.value) return;

  try {
    if (channel === 'tasks') {
      await Promise.all([refreshList(), refreshInvestigations()]);
      if (selected.value) selected.value = await reload(() => api.getTask(selected.value!.ref));
      if (selectedInvestigation.value) {
        selectedInvestigation.value = await reload(() =>
          api.getInvestigation(selectedInvestigation.value!.ref),
        );
      }
      if (view.value === 'branches') await refreshBranches();
      return;
    }

    if (view.value === 'notes') {
      await refreshNotes();
      if (selectedNote.value) selectedNote.value = await reload(() => api.getNote(selectedNote.value!.path));
    }

    if (view.value === 'issues') {
      await refreshIssues();
      if (selectedIssue.value) selectedIssue.value = await reload(() => api.getIssue(selectedIssue.value!.id));
    }
  } catch {
    // A background refresh that fails is not worth a toast: the screen keeps
    // what it had, and the next change — or any click — tries again.
  }
}

/** Reload one selected record. Something deleted elsewhere simply deselects
 *  rather than leaving an error over a screen the user did not touch. */
async function reload<T>(fetch_: () => Promise<T>): Promise<T | null> {
  try {
    return await fetch_();
  } catch {
    return null;
  }
}

const { connected: liveConnected, unavailable: liveUnavailable } = useLiveUpdates(
  (channel) => void refreshFromChange(channel),
);

watch(location, (path) => {
  const next = viewForPath(path);
  if (path !== VIEW_PATHS[next]) {
    window.history.replaceState({}, '', VIEW_PATHS[next]);
    location.value = VIEW_PATHS[next];
    return;
  }
  if (next !== view.value) void showView(next);
});

onMounted(async () => {
  try {
    // The rail's investigation count is visible from every view, so the list is
    // loaded up front even though Tasks is what opens first.
    [meta.value] = await Promise.all([api.meta(), refreshList(), refreshInvestigations()]);
    if (tasks.value.length) await select(tasks.value[0]!.ref);
    const initialView = viewForPath(location.value);
    if (location.value !== VIEW_PATHS[initialView]) {
      window.history.replaceState({}, '', VIEW_PATHS[initialView]);
      location.value = VIEW_PATHS[initialView];
    }
    await showView(initialView);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="app">
    <!-- ------------------------------------------------------------- rail -->
    <nav class="rail" aria-label="Sections">
      <button
        class="rail-item"
        :class="{ active: location === '/investigations' }"
        title="Investigations"
        aria-label="Investigations"
        :aria-current="location === '/investigations'"
        @click="navigateTo('investigations')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
        </svg>
        <span v-if="openInvestigations" class="rail-count">{{ openInvestigations }}</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/tasks' }"
        title="Tasks"
        aria-label="Tasks"
        :aria-current="location === '/tasks'"
        @click="navigateTo('tasks')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/branches' }"
        title="Branches"
        aria-label="Branches"
        :aria-current="location === '/branches'"
        @click="navigateTo('branches')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="6" cy="5" r="2.5" />
          <circle cx="6" cy="19" r="2.5" />
          <circle cx="18" cy="12" r="2.5" />
          <path d="M6 7.5v9" />
          <path d="M15.5 12H12a6 6 0 0 1-6-6" />
        </svg>
        <span v-if="branches.length" class="rail-count">{{ branches.length }}</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/notes' }"
        title="Notes"
        aria-label="Notes"
        :aria-current="location === '/notes'"
        @click="navigateTo('notes')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          <path d="M14 3v5h5" />
          <path d="M8 13h7M8 17h5" />
        </svg>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/issues' }"
        title="Issues"
        aria-label="Issues"
        :aria-current="location === '/issues'"
        @click="navigateTo('issues')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" />
          <path d="M12 16.5v.01" />
        </svg>
        <span v-if="issueFacets.total" class="rail-count">{{ issueFacets.total }}</span>
      </button>

      <!-- Only ever shown when live updates are *not* working. A page that
           quietly stopped following the workspace looks exactly like one where
           nothing has happened, which is the failure worth naming. -->
      <span
        v-if="!liveConnected"
        class="rail-live"
        :class="{ gone: liveUnavailable }"
        role="status"
        :title="liveUnavailable
          ? 'Live updates are unavailable — this server predates /api/events. Restart `tasks web` and reload; until then, changes made elsewhere appear when you switch views.'
          : 'Live updates disconnected — reconnecting. Changes made elsewhere may not be showing.'"
      >
        <span class="rail-live-dot" />
      </span>
    </nav>

    <!-- ----------------------------------------------- investigations list -->
    <aside v-if="location === '/investigations'" class="sidebar">
      <div class="sidebar-header">
        <h1>Investigations</h1>
        <div class="row">
          <p class="faint" style="margin: 0; flex: 1">
            Questions to look into. Run one to turn it into tasks.
          </p>
          <button class="primary" @click="creatingInvestigation = true">New</button>
        </div>
      </div>

      <div class="task-list">
        <button
          v-for="investigation in investigations"
          :key="investigation.ref"
          class="task-item"
          :class="{ selected: selectedInvestigation?.ref === investigation.ref }"
          @click="selectInvestigation(investigation.ref)"
        >
          <div class="row">
            <span class="mono faint">{{ investigation.ref }}</span>
            <span class="badge" :class="investigation.status">
              {{ INVESTIGATION_STATUS_LABELS[investigation.status] }}
            </span>
          </div>
          <div class="task-item-title">{{ investigation.title }}</div>
        </button>

        <p v-if="!investigationsLoading && !investigations.length" class="empty">
          Nothing to investigate yet. Write the first question down.
        </p>
      </div>
    </aside>

    <!-- -------------------------------------------------------- tasks list -->
    <aside v-else-if="location === '/tasks'" class="sidebar">
      <div class="sidebar-header">
        <h1>Tasks</h1>
        <div class="row">
          <select v-model="filter" aria-label="Filter by status">
            <option value="all">All ({{ counts.all }})</option>
            <option v-for="status in STATUSES" :key="status" :value="status">
              {{ STATUS_LABELS[status] }} ({{ counts[status] }})
            </option>
          </select>
          <button class="primary" @click="creating = true">New</button>
        </div>
      </div>

      <div class="task-list">
        <button
          v-for="task in visibleTasks"
          :key="task.ref"
          class="task-item"
          :class="{
            selected: selected?.ref === task.ref,
            dragging: draggingRef === task.ref,
            'drop-above': dropTargetRef === task.ref && !dropBelow,
            'drop-below': dropTargetRef === task.ref && dropBelow,
          }"
          draggable="true"
          :title="`${task.ref} — drag to reorder, or Alt+↑/↓`"
          @click="select(task.ref)"
          @dragstart="onDragStart(task.ref, $event)"
          @dragover="onDragOver(task.ref, $event)"
          @dragleave="onDragLeave(task.ref, $event)"
          @drop.prevent="onDrop(task.ref)"
          @dragend="endDrag"
          @keydown.alt.up.prevent="moveBy(task.ref, -1)"
          @keydown.alt.down.prevent="moveBy(task.ref, 1)"
        >
          <div class="row">
            <span class="drag-grip" aria-hidden="true">⠿</span>
            <input
              class="task-select"
              type="checkbox"
              :checked="selectedRefs.has(task.ref)"
              :aria-label="`Select ${task.ref}`"
              @click.stop
              @change="toggleTask(task.ref)"
            />
            <span class="mono faint">{{ task.ref }}</span>
            <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
            <span class="spacer" />
            <span v-if="task.priority !== 'medium'" :class="`priority-${task.priority}`">
              {{ task.priority === 'high' ? '!' : '·' }}
            </span>
          </div>
          <div class="task-item-title">{{ task.title }}</div>
          <div v-if="task.tags.length" class="faint">#{{ task.tags.join(' #') }}</div>
        </button>

        <p v-if="!loading && !visibleTasks.length" class="empty">
          No tasks here yet.
        </p>
        <p v-else-if="!loading" class="faint reorder-hint">
          Drag to reorder, or Alt+↑/↓. The top task is what
          <span class="mono">/work-task</span> picks up.
        </p>
      </div>
      <div v-if="selectedRefs.size" class="combine-panel">
        <strong>{{ selectedRefs.size }} selected</strong>
        <button class="primary" @click="combineSelected">
          {{ selectedRefs.size === 1 ? 'Review & prepare branch' : 'Review & combine branches' }}
        </button>
        <p v-if="selectedRefs.size === 1" class="faint">Only Dev Complete or Verified tasks can be prepared. The task's work is copied onto a delivery branch you name, ready for a PR. Closing requires the task to be Verified.</p>
        <p v-else class="faint">Only Dev Complete or Verified tasks can be combined. Their branches are cherry-picked in task-list order. Closing requires every selected task to be Verified.</p>
      </div>
    </aside>

    <!-- -------------------------------------------------------- notes list -->
    <aside v-else-if="location === '/notes'" class="sidebar">
      <div class="sidebar-header">
        <h1>Notes</h1>
        <div class="row">
          <input
            v-model="notesFilter.q"
            class="note-search"
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
          />
          <button
            class="primary"
            :disabled="!notesWorkspace?.exists"
            title="New note"
            @click="creatingNote = true"
          >
            New
          </button>
        </div>
        <div v-if="noteFolders.length || noteTags.length" class="row" style="margin-top: 8px">
          <select v-if="noteFolders.length" v-model="notesFilter.folder" aria-label="Filter by folder">
            <option value="">All folders</option>
            <option v-for="folder in noteFolders" :key="folder" :value="folder">{{ folder }}</option>
          </select>
          <select v-if="noteTags.length" v-model="notesFilter.tag" aria-label="Filter by tag">
            <option value="">All tags</option>
            <option v-for="tag in noteTags" :key="tag" :value="tag">#{{ tag }}</option>
          </select>
        </div>
      </div>

      <div class="task-list">
        <button
          v-for="note in notes"
          :key="note.path"
          class="task-item"
          :class="{ selected: selectedNote?.path === note.path }"
          @click="selectNote(note.path)"
        >
          <div class="row">
            <span v-if="note.folder" class="mono faint">{{ note.folder }}/</span>
            <span class="spacer" />
            <span class="faint">{{ note.updatedAt.slice(0, 10) }}</span>
          </div>
          <div class="task-item-title">{{ note.title }}</div>
          <div v-if="note.excerpt" class="faint note-excerpt">{{ note.excerpt }}</div>
          <div v-if="note.tags.length" class="faint">#{{ note.tags.join(' #') }}</div>
        </button>

        <p v-if="!notesLoading && !notes.length && notesWorkspace?.exists" class="empty">
          {{ notesFilter.q || notesFilter.tag || notesFilter.folder
            ? 'Nothing matches that.'
            : 'No notes yet. Write the first one.' }}
        </p>
      </div>

      <!-- The notes folder is an ordinary Git repository, so its state belongs
           on screen: an edit that was never committed is an edit that is only on
           this machine. -->
      <div v-if="notesWorkspace" class="notes-status">
        <p class="mono faint" :title="notesWorkspace.dir">{{ notesWorkspace.dir }}</p>
        <template v-if="!notesWorkspace.exists">
          <p class="faint">That folder does not exist yet.</p>
          <button class="primary" :disabled="notesLoading" @click="initNotes">Create it</button>
        </template>
        <template v-else-if="!notesWorkspace.git.repo">
          <p class="faint">Not a Git repository — nothing here is versioned.</p>
          <button :disabled="notesLoading" @click="initNotes">git init</button>
        </template>
        <template v-else>
          <p class="faint">
            <span class="mono">{{ notesWorkspace.git.branch ?? 'detached' }}</span>
            ·
            {{ notesWorkspace.git.dirty ? `${notesWorkspace.git.dirty} uncommitted` : 'clean' }}
            <template v-if="notesWorkspace.git.unpushed">
              · {{ notesWorkspace.git.unpushed }} unpushed
            </template>
            <template v-if="notesWorkspace.autoCommit"> · auto-commit on</template>
          </p>
          <div class="row">
            <button :disabled="notesLoading || !notesWorkspace.git.dirty" @click="syncNotes(false)">
              Commit
            </button>
            <button
              :disabled="notesLoading || !notesWorkspace.git.upstream"
              :title="notesWorkspace.git.upstream ?? 'No upstream configured for this repository.'"
              @click="syncNotes(true)"
            >
              Push
            </button>
          </div>
        </template>
      </div>
    </aside>

    <!-- ---------------------------------------------------- issues filters -->
    <aside v-else-if="location === '/issues'" class="sidebar">
      <div class="sidebar-header">
        <h1>Issues</h1>
        <p class="faint" style="margin: 0 0 10px">
          Read from the JSON files in the notes folder. Nothing here is fetched or written.
        </p>
        <input
          v-model="issuesFilter.q"
          class="note-search"
          type="search"
          placeholder="Search issues"
          aria-label="Search issues"
        />
      </div>

      <div class="task-list issue-filters">
        <div class="field">
          <label for="issue-state">State</label>
          <select id="issue-state" v-model="issuesFilter.state">
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>

        <!-- One provider today, more later: the filter is a list rather than a
             toggle so a second source needs nothing here but its own files. -->
        <div v-if="issueFacets.sources.length > 1" class="field">
          <label for="issue-source">Source</label>
          <select id="issue-source" v-model="issuesFilter.source">
            <option value="">All sources</option>
            <option v-for="entry in issueFacets.sources" :key="entry.source" :value="entry.source">
              {{ ISSUE_SOURCE_LABELS[entry.source] ?? entry.source }} ({{ entry.count }})
            </option>
          </select>
        </div>

        <div v-if="issueFacets.labels.length" class="field">
          <label for="issue-label">Label</label>
          <select id="issue-label" v-model="issuesFilter.label">
            <option value="">All labels</option>
            <option v-for="label in issueFacets.labels" :key="label" :value="label">{{ label }}</option>
          </select>
        </div>

        <p class="faint">
          {{ issues.length }} of {{ issueFacets.total }} shown.
          <template v-if="issueFacets.sources.length">
            <br />
            {{ issueFacets.sources.map((entry) => `${ISSUE_SOURCE_LABELS[entry.source] ?? entry.source}: ${entry.count}`).join(' · ') }}
          </template>
        </p>
      </div>
    </aside>

    <!-- ----------------------------------------------------- branches list -->
    <aside v-else class="sidebar">
      <div class="sidebar-header">
        <h1>Branches</h1>
        <p class="faint" style="margin: 0">
          Delivery branches built by combining tasks.
        </p>
      </div>

      <div class="task-list">
        <button
          v-for="branch in branches"
          :key="branch.branchName"
          class="task-item"
          :class="{ selected: selectedBranch === branch.branchName }"
          @click="selectedBranch = branch.branchName"
        >
          <div class="row">
            <span class="badge" :class="branch.prUrl ? 'verified' : 'in_progress'">
              {{ branch.prUrl ? `PR #${branch.prNumber ?? '?'}` : 'No PR' }}
            </span>
            <span class="spacer" />
            <span class="faint">{{ branch.git.commits.length }} commit(s)</span>
          </div>
          <div class="task-item-title mono">{{ branch.branchName }}</div>
          <div class="faint">
            {{ branch.taskRefs.join(', ') || 'no tasks recorded' }}
          </div>
        </button>

        <p v-if="!branchesLoading && !branches.length" class="empty">
          No delivery branches yet. Select a finished task under Tasks to prepare its
          branch, or two or more to combine them.
        </p>
      </div>
    </aside>

    <!-- ----------------------------------------------------------- detail -->
    <InvestigationDetail
      v-if="location === '/investigations' && selectedInvestigation"
      :key="selectedInvestigation.ref"
      :investigation="selectedInvestigation"
      @changed="onInvestigationChanged"
      @deleted="onInvestigationDeleted"
      @open-task="openTask"
    />

    <TaskDetail
      v-else-if="location === '/tasks' && selected"
      :key="selected.ref"
      :task="selected"
      :aio-vr-ready="Boolean(meta?.aioVrInstalled && meta?.aioVrWorkspaceExists)"
      @changed="onChanged"
      @deleted="onDeleted"
      @open-investigation="openInvestigation"
    />

    <CombineBranches
      v-else-if="location === '/combine'"
      :refs="[...selectedRefs]"
      @close="navigateTo('tasks')"
      @started="combineStarted"
    />

    <NoteDetail
      v-else-if="location === '/notes' && selectedNote"
      :key="selectedNote.path"
      :note="selectedNote"
      @changed="onNoteChanged"
      @deleted="onNoteDeleted"
      @renamed="selectNote"
    />

    <IssueDetail
      v-else-if="location === '/issues' && selectedIssue"
      :key="selectedIssue.id"
      :issue="selectedIssue"
      @back="selectedIssue = null"
    />

    <IssueCards
      v-else-if="location === '/issues'"
      :issues="issues"
      :loading="issuesLoading"
      :filtered="issuesFiltered"
      :notes-dir="notesWorkspace?.dir ?? null"
      @open="openIssue"
    />

    <BranchDetail
      v-else-if="location === '/branches' && currentBranch"
      :key="currentBranch.branchName"
      :branch="currentBranch"
      :meta="meta"
      @changed="onBranchChanged"
      @forgotten="onBranchForgotten"
      @open-task="openTask"
      @continue-combine="continueCombine"
    />

    <section v-else class="detail">
      <p class="empty">
        <template v-if="location === '/branches'">
          {{ branchesLoading ? 'Loading…' : 'Prepare or combine some tasks to get a delivery branch here.' }}
        </template>
        <template v-else-if="location === '/notes'">
          {{ notesLoading
            ? 'Loading…'
            : notesWorkspace && !notesWorkspace.exists
              ? 'The notes folder does not exist yet. Create it from the panel on the left.'
              : 'Select a note, or write a new one. They are Markdown files in their own Git repository.' }}
        </template>
        <template v-else-if="location === '/investigations'">
          {{ investigationsLoading
            ? 'Loading…'
            : 'Write down what is worth looking into, then run it to get tasks out of it.' }}
        </template>
        <template v-else>
          {{ loading ? 'Loading…' : 'Select a task, or create one to get started.' }}
        </template>
      </p>
    </section>

    <!-- ------------------------------------------------------------- error -->
    <!-- Outside every pane on purpose. This used to live in the empty-detail
         section, which renders only when nothing is selected — so a failed
         action on a selected task reverted the list with nothing said. -->
    <div v-if="error" class="toast" role="alert">
      <span>{{ error }}</span>
      <button class="toast-dismiss" aria-label="Dismiss" @click="error = null">×</button>
    </div>

    <!-- ------------------------------------------------- new investigation -->
    <div v-if="creatingInvestigation" class="overlay" @click.self="creatingInvestigation = false">
      <div class="dialog">
        <h3>New investigation</h3>
        <div class="field">
          <label for="new-inv-title">Title</label>
          <input
            id="new-inv-title"
            v-model="newInvestigation.title"
            placeholder="Why is the plan gantt slow on mobile?"
            autofocus
          />
        </div>
        <div class="field">
          <label for="new-inv-brief">What to investigate</label>
          <textarea
            id="new-inv-brief"
            v-model="newInvestigation.brief"
            style="min-height: 180px"
            placeholder="What you want looked into, and anything you already know — a symptom, a file, a hunch. The agent reads this."
          />
        </div>
        <div class="row">
          <button
            class="primary"
            :disabled="!newInvestigation.title.trim()"
            @click="createInvestigation"
          >
            Create
          </button>
          <button @click="creatingInvestigation = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- ---------------------------------------------------------- new note -->
    <div v-if="creatingNote" class="overlay" @click.self="creatingNote = false">
      <div class="dialog">
        <h3>New note</h3>
        <div class="field">
          <label for="new-note-title">Title</label>
          <input id="new-note-title" v-model="newNote.title" autofocus @keyup.enter="createNote" />
        </div>
        <div class="field">
          <label for="new-note-folder">
            Folder <span class="faint">(optional; the file is named from the title)</span>
          </label>
          <input id="new-note-folder" v-model="newNote.folder" list="note-folders" placeholder="ideas" />
          <datalist id="note-folders">
            <option v-for="folder in noteFolders" :key="folder" :value="folder" />
          </datalist>
        </div>
        <div class="row">
          <button class="primary" :disabled="!newNote.title.trim()" @click="createNote">Create</button>
          <button @click="creatingNote = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- ---------------------------------------------------------- new task -->
    <div v-if="creating" class="overlay" @click.self="creating = false">
      <div class="dialog">
        <h3>New task</h3>
        <div class="field">
          <label for="new-title">Title</label>
          <input id="new-title" v-model="newTask.title" autofocus @keyup.enter="createTask" />
        </div>
        <div class="field">
          <label for="new-desc">Description</label>
          <textarea id="new-desc" v-model="newTask.description" />
        </div>
        <div class="field">
          <label for="new-branch">Branch name <span class="faint">(optional; generated from title)</span></label>
          <input id="new-branch" v-model="newTask.branchName" placeholder="feature/t-42-my-task" />
        </div>
        <div class="row">
          <div class="field" style="flex: 1">
            <label for="new-priority">Priority</label>
            <select id="new-priority" v-model="newTask.priority">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
          <div class="field" style="flex: 2">
            <label for="new-tags">Tags (comma separated)</label>
            <input id="new-tags" v-model="newTask.tags" />
          </div>
        </div>
        <div class="row">
          <button class="primary" :disabled="!newTask.title.trim()" @click="createTask">
            Create
          </button>
          <button @click="creating = false">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>
