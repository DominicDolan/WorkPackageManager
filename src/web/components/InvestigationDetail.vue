<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  INVESTIGATION_STATUS_LABELS,
  STATUS_LABELS,
  type InvestigationDetail,
  type InvestigationStatus,
} from '@shared/types';
import { api } from '../api';
import AgentRunDialog from './AgentRunDialog.vue';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps<{ investigation: InvestigationDetail }>();
const emit = defineEmits<{
  changed: [InvestigationDetail];
  deleted: [string];
  openTask: [string];
}>();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const copied = ref(false);
const running = ref(false);
const briefMode = ref<'write' | 'read'>('write');

/** A run writes findings and status back, so reload when the dialog is closed. */
async function agentDialogClosed(): Promise<void> {
  running.value = false;
  try {
    emit('changed', await api.getInvestigation(props.investigation.ref));
  } catch {
    // Deleted by whatever ran; the list column will reflect that.
  }
}

/** The brief is the point of this view, so it is a live editing surface rather
 *  than something behind an Edit button. Saved explicitly — losing a half-written
 *  brief to a stray click would be the worst failure here. */
const draft = ref({ title: '', brief: '' });

watch(
  () => props.investigation.ref,
  () => {
    draft.value = { title: props.investigation.title, brief: props.investigation.brief };
    error.value = null;
    copied.value = false;
  },
  { immediate: true },
);

// A run by the agent writes findings and status back; pick those up without
// throwing away anything typed here in the meantime.
watch(
  () => props.investigation.brief,
  (brief) => {
    if (!dirty.value) draft.value.brief = brief;
  },
);

const dirty = computed(
  () =>
    draft.value.title !== props.investigation.title ||
    draft.value.brief !== props.investigation.brief,
);

const command = computed(() => `/plan-tasks ${props.investigation.ref}`);

async function run(label: string, action: () => Promise<InvestigationDetail>): Promise<void> {
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

const save = () =>
  run('save', () =>
    api.updateInvestigation(props.investigation.ref, {
      title: draft.value.title,
      brief: draft.value.brief,
    }),
  );

const changeStatus = (status: InvestigationStatus) =>
  run(status, () => api.setInvestigationStatus(props.investigation.ref, status));

async function copyCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be refused; the command is on screen to be typed.
    error.value = 'Could not copy — the command is shown above.';
  }
}

async function remove(): Promise<void> {
  const filed = props.investigation.tasks.length;
  const warning = filed
    ? ` The ${filed} task(s) it filed are kept, no longer linked to it.`
    : '';
  if (!confirm(`Delete ${props.investigation.ref}?${warning}`)) return;

  busy.value = 'delete';
  try {
    await api.deleteInvestigation(props.investigation.ref);
    emit('deleted', props.investigation.ref);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

const formatDate = (value: string) => new Date(value).toLocaleString();
</script>

<template>
  <section class="detail">
    <p v-if="error" class="banner">{{ error }}</p>

    <AgentRunDialog
      v-if="running"
      command="plan-tasks"
      :target="investigation.ref"
      subject-kind="investigation"
      :subject-ref="investigation.ref"
      :subject-title="investigation.title"
      @close="agentDialogClosed"
    />

    <div class="detail-header">
      <span class="mono dim">{{ investigation.ref }}</span>
      <input
        v-model="draft.title"
        class="title-input"
        aria-label="Investigation title"
        @keyup.enter="dirty && save()"
      />
    </div>

    <div class="row" style="flex-wrap: wrap; margin-bottom: 8px">
      <span class="badge" :class="investigation.status">
        {{ INVESTIGATION_STATUS_LABELS[investigation.status] }}
      </span>
      <span class="faint">
        {{ investigation.completedAt
          ? `Investigated ${formatDate(investigation.completedAt)}`
          : `Written ${formatDate(investigation.createdAt)}` }}
      </span>
      <span class="spacer" />
      <button
        v-if="investigation.status !== 'draft'"
        :disabled="!!busy"
        @click="changeStatus('draft')"
      >
        Reopen as draft
      </button>
      <button class="danger" :disabled="!!busy" @click="remove">Delete</button>
    </div>

    <!-- ------------------------------------------------------------- brief -->
    <div class="section">
      <div class="section-head">
        <h3>What to investigate</h3>
        <span class="spacer" />
        <!-- Read previews the draft, not the stored brief: what you are checking
             is what you just typed. -->
        <div class="modes" role="group" aria-label="Brief view">
          <button :class="{ active: briefMode === 'write' }" @click="briefMode = 'write'">Write</button>
          <button :class="{ active: briefMode === 'read' }" @click="briefMode = 'read'">Read</button>
        </div>
      </div>

      <template v-if="briefMode === 'read'">
        <MarkdownBlock v-if="draft.brief.trim()" :source="draft.brief" />
        <p v-else class="empty">Nothing written yet.</p>
      </template>

      <div v-else class="panel">
        <textarea
          v-model="draft.brief"
          class="brief-input"
          aria-label="Investigation brief"
          placeholder="What is worth looking into, and why? Anything you already know — a symptom, a file, a hunch — saves the agent a lap. Markdown."
        />
      </div>

      <div class="row" style="margin-top: 10px">
        <button class="primary" :disabled="!dirty || busy === 'save'" @click="save">
          {{ busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved' }}
        </button>
        <span v-if="dirty" class="faint">Unsaved changes.</span>
      </div>
    </div>

    <!-- --------------------------------------------------------------- run -->
    <div class="section">
      <h3>Run it</h3>
      <div class="panel">
        <p class="dim" style="margin-top: 0">
          Run this in Claude Code or pi from the repository root. The agent reads the
          brief, investigates, files what it finds as tasks against
          {{ investigation.ref }}, and writes its findings back here.
        </p>
        <div class="row">
          <code class="mono command">{{ command }}</code>
          <button :disabled="!!busy" @click="copyCommand">{{ copied ? 'Copied' : 'Copy' }}</button>
          <button class="primary" :disabled="!!busy" @click="running = true">Run it here</button>
        </div>
        <p v-if="dirty" class="banner warn" style="margin: 12px 0 0">
          Save the brief first — the agent reads what is stored, not what is on screen.
        </p>
      </div>
    </div>

    <!-- ---------------------------------------------------------- findings -->
    <div class="section">
      <h3>Findings</h3>
      <!-- Written by an agent, in Markdown, and usually the longest thing on
           this page — headings and lists are the difference between reading it
           and skimming past it. Copy gives the Markdown back. -->
      <MarkdownBlock v-if="investigation.findings" :source="investigation.findings" />
      <p v-else class="empty">
        Nothing yet. Findings appear here once the investigation has been run.
      </p>
    </div>

    <!-- ------------------------------------------------------------- tasks -->
    <div class="section">
      <h3>Tasks filed ({{ investigation.tasks.length }})</h3>
      <div v-if="investigation.tasks.length" class="panel row" style="flex-wrap: wrap">
        <button
          v-for="task in investigation.tasks"
          :key="task.ref"
          class="task-chip"
          :title="task.title"
          @click="emit('openTask', task.ref)"
        >
          <span class="mono faint">{{ task.ref }}</span>
          <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
          <span class="task-chip-title">{{ task.title }}</span>
        </button>
      </div>
      <p v-else class="empty">
        No tasks yet. Running the investigation is what fills this in.
      </p>
    </div>
  </section>
</template>
