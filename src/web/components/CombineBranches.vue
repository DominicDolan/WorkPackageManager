<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { BranchCommit, TaskDetail } from '@shared/types';
import { api } from '../api';

const props = defineProps<{ refs: string[] }>();
const emit = defineEmits<{ close: []; started: [branchName: string] }>();
type Row = { task: TaskDetail; exists: boolean; candidates: string[]; commits: BranchCommit[] };
const rows = ref<Row[]>([]);
const loading = ref(true);
const saving = ref<string | null>(null);
const error = ref<string | null>(null);
const branchName = ref('');
const closeTasks = ref(true);
const base = ref('');
const working = ref(false);
/** One task takes the same path as a combine — cut a branch, cherry-pick onto
 *  it, hand it to the PR flow — so only the wording changes. */
const single = computed(() => props.refs.length === 1);
/** Every commit that will be picked, in the order it will be picked. */
const totalCommits = computed(() => rows.value.reduce((sum, row) => sum + row.commits.length, 0));
/** A task whose branch is missing, or which has nothing to pick, would only be
 *  rejected by the server — so say so here instead of after the click. */
const ready = computed(() =>
  Boolean(branchName.value.trim()) &&
  rows.value.length > 0 &&
  rows.value.every((row) => row.exists && row.commits.length > 0),
);

async function load() {
  loading.value = true; error.value = null;
  try {
    const preview = await api.previewCombine(props.refs);
    rows.value = preview.tasks;
    base.value = preview.base;
  }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
  finally { loading.value = false; }
}
async function assign(row: Row, name: string) {
  saving.value = row.task.ref; error.value = null;
  try { await api.updateTask(row.task.ref, { branchName: name }); await load(); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
  finally { saving.value = null; }
}
async function combine() {
  if (working.value || !ready.value) return;
  working.value = true;
  error.value = null;
  try {
    const result = await api.combineTasks(rows.value.map((row) => row.task.ref), branchName.value.trim(), closeTasks.value);
    emit('started', result.branchName);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
  finally { working.value = false; }
}
onMounted(load);
</script>

<template>
  <section class="detail combine-create">
    <header class="detail-header"><div><p class="eyebrow">Delivery branch</p><h2>{{ single ? 'Prepare branch' : 'Combine branches' }}</h2></div><button @click="emit('close')">Cancel</button></header>
    <p class="faint">
      {{ single
        ? 'Review the task branch, fix its assignment if needed, then copy its work onto a new branch under the name you want on the PR.'
        : 'Review the task branches, fix assignments, then cherry-pick all selected work in this order.' }}
    </p>
    <p v-if="error" class="banner warn">{{ error }}</p>
    <p v-if="loading">Checking branches…</p>
    <div v-else class="panel">
      <div v-for="row in rows" :key="row.task.ref" class="combine-row">
        <strong class="mono">{{ row.task.ref }}</strong><span>{{ row.task.title }}</span>
        <code class="mono">{{ row.task.branchName }}</code>
        <span v-if="row.exists" class="badge verified">Ready</span>
        <template v-else><span class="badge failed">Branch missing</span>
          <select v-if="row.candidates.length" :disabled="saving === row.task.ref" @change="assign(row, ($event.target as HTMLSelectElement).value)">
            <option value="">Reassign branch…</option><option v-for="candidate in row.candidates" :key="candidate" :value="candidate">{{ candidate }}</option>
          </select>
          <span v-else class="faint">No matching local branch found</span>
        </template>

        <ol v-if="row.commits.length" class="commit-preview">
          <li v-for="commit in row.commits" :key="commit.sha">
            <code class="mono">{{ commit.shortSha }}</code>
            <span>{{ commit.subject }}</span>
          </li>
        </ol>
        <p v-else-if="row.exists" class="faint commit-preview-empty">
          No commits ahead of <code class="mono">{{ base }}</code> — this task has nothing to pick.
        </p>
      </div>
    </div>
    <p v-if="!loading && rows.length" class="faint">
      {{ totalCommits }} commit(s) will be cherry-picked onto the new branch, in this order.
    </p>
    <div class="panel"><label>{{ single ? 'Branch name' : 'Combined branch name' }}</label><input v-model="branchName" placeholder="feature/my-delivery" />
      <label class="combine-close"><input v-model="closeTasks" type="checkbox" /> {{ single ? 'Close the task after completion if it is verified' : 'Close verified tasks after completion' }}</label>
      <p v-if="base" class="faint">
        Cut from <code class="mono">{{ base }}</code>, which is fetched and fast-forwarded to
        <code class="mono">origin/{{ base }}</code> first. The branch you have checked out now does not matter.
      </p>
      <button class="primary" :disabled="working || !ready" @click="combine">
        {{ working ? 'Working…' : single ? 'Prepare Branch' : 'Combine All' }}
      </button>
    </div>
  </section>
</template>
