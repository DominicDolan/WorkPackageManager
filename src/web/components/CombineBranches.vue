<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { TaskDetail } from '@shared/types';
import { api } from '../api';

const props = defineProps<{ refs: string[] }>();
const emit = defineEmits<{ close: []; started: [branchName: string] }>();
type Row = { task: TaskDetail; exists: boolean; candidates: string[] };
const rows = ref<Row[]>([]);
const loading = ref(true);
const saving = ref<string | null>(null);
const error = ref<string | null>(null);
const branchName = ref('');
const closeTasks = ref(true);
/** One task takes the same path as a combine — cut a branch, cherry-pick onto
 *  it, hand it to the PR flow — so only the wording changes. */
const single = computed(() => props.refs.length === 1);

async function load() {
  loading.value = true; error.value = null;
  try { rows.value = (await api.previewCombine(props.refs)).tasks; }
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
  if (!branchName.value.trim() || rows.value.some((row) => !row.exists)) return;
  error.value = null;
  try {
    const result = await api.combineTasks(rows.value.map((row) => row.task.ref), branchName.value.trim(), closeTasks.value);
    emit('started', result.branchName);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
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
      </div>
    </div>
    <div class="panel"><label>{{ single ? 'Branch name' : 'Combined branch name' }}</label><input v-model="branchName" placeholder="feature/my-delivery" />
      <label class="combine-close"><input v-model="closeTasks" type="checkbox" /> {{ single ? 'Close the task after completion if it is verified' : 'Close verified tasks after completion' }}</label>
      <button class="primary" :disabled="!branchName.trim() || rows.some((row) => !row.exists)" @click="combine">{{ single ? 'Prepare Branch' : 'Combine All' }}</button>
    </div>
  </section>
</template>
