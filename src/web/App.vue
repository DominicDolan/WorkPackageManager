<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  STATUS_LABELS,
  STATUSES,
  type CombinedBranchDetail,
  type Priority,
  type Status,
  type Task,
  type TaskDetail as TaskDetailModel,
} from '@shared/types';
import { api, type Meta } from './api';
import BranchDetail from './components/BranchDetail.vue';
import TaskDetail from './components/TaskDetail.vue';

/** Which rail section is showing. */
type View = 'tasks' | 'branches';

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

const view = ref<View>('tasks');
const branches = ref<CombinedBranchDetail[]>([]);
const selectedBranch = ref<string | null>(null);
const branchesLoading = ref(false);

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
}

/** Jump from a branch's task chip back to that task. */
async function openTask(ref_: string): Promise<void> {
  view.value = 'tasks';
  await select(ref_);
}

async function combineSelected(): Promise<void> {
  if (selectedRefs.value.size < 2 || !combineBranchName.value.trim()) return;
  combining.value = true;
  error.value = null;
  try {
    const result = await api.combineTasks(
      [...selectedRefs.value],
      combineBranchName.value.trim(),
      closeCombinedTasks.value,
    );
    selectedRefs.value = new Set();
    combineBranchName.value = '';
    closeCombinedTasks.value = true;
    await refreshList();
    await select(result.tasks[0]!.ref);
    // The branch is the thing you want next — its description and PR live there.
    selectedBranch.value = result.branchName;
    await showView('branches');
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
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

onMounted(async () => {
  try {
    [meta.value] = await Promise.all([api.meta(), refreshList()]);
    if (tasks.value.length) await select(tasks.value[0]!.ref);
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
        :class="{ active: view === 'tasks' }"
        title="Tasks"
        aria-label="Tasks"
        :aria-current="view === 'tasks'"
        @click="showView('tasks')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </button>

      <button
        class="rail-item"
        :class="{ active: view === 'branches' }"
        title="Branches"
        aria-label="Branches"
        :aria-current="view === 'branches'"
        @click="showView('branches')"
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
    </nav>

    <!-- -------------------------------------------------------- tasks list -->
    <aside v-if="view === 'tasks'" class="sidebar">
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
          :class="{ selected: selected?.ref === task.ref }"
          @click="select(task.ref)"
        >
          <div class="row">
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
      </div>
      <div v-if="selectedRefs.size" class="combine-panel">
        <strong>{{ selectedRefs.size }} selected</strong>
        <input v-model="combineBranchName" placeholder="Combined branch name" @keyup.enter="combineSelected" />
        <label class="combine-close"><input v-model="closeCombinedTasks" type="checkbox" /> Close tasks</label>
        <button class="primary" :disabled="selectedRefs.size < 2 || !combineBranchName.trim() || combining" @click="combineSelected">
          {{ combining ? 'Combining…' : 'Combine branches' }}
        </button>
        <p class="faint">Only Dev Complete or Verified tasks can be combined. Their branches are cherry-picked in task-list order. Closing requires every selected task to be Verified.</p>
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
          No combined branches yet. Select two or more finished tasks under Tasks and
          combine them.
        </p>
      </div>
    </aside>

    <!-- ----------------------------------------------------------- detail -->
    <TaskDetail
      v-if="view === 'tasks' && selected"
      :key="selected.ref"
      :task="selected"
      :aio-vr-ready="Boolean(meta?.aioVrInstalled && meta?.aioVrWorkspaceExists)"
      @changed="onChanged"
      @deleted="onDeleted"
    />

    <BranchDetail
      v-else-if="view === 'branches' && currentBranch"
      :key="currentBranch.branchName"
      :branch="currentBranch"
      :meta="meta"
      @changed="onBranchChanged"
      @forgotten="onBranchForgotten"
      @open-task="openTask"
    />

    <section v-else class="detail">
      <p v-if="error" class="banner">{{ error }}</p>
      <p class="empty">
        <template v-if="view === 'branches'">
          {{ branchesLoading ? 'Loading…' : 'Combine some tasks to get a delivery branch here.' }}
        </template>
        <template v-else>
          {{ loading ? 'Loading…' : 'Select a task, or create one to get started.' }}
        </template>
      </p>
    </section>

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
