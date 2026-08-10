<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { STATUS_LABELS, type CombinedBranchDetail } from '@shared/types';
import { api, type Meta } from '../api';

const props = defineProps<{ branch: CombinedBranchDetail; meta: Meta | null }>();
const emit = defineEmits<{
  changed: [CombinedBranchDetail];
  forgotten: [string];
  openTask: [string];
}>();

const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const draft = ref({ title: '', body: '' });
const draftDraftPr = ref(false);
const showCommits = ref(false);

/** The editable copy is reseeded whenever the server hands back a new version —
 *  including right after a generation, which is how the result lands in the form. */
watch(
  () => [props.branch.branchName, props.branch.updatedAt] as const,
  () => {
    draft.value = { title: props.branch.prTitle ?? '', body: props.branch.prBody ?? '' };
    error.value = null;
    notice.value = null;
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    draft.value.title !== (props.branch.prTitle ?? '') ||
    draft.value.body !== (props.branch.prBody ?? ''),
);

const base = computed(() => props.branch.baseBranch ?? '—');
const hasDescription = computed(() => Boolean(draft.value.title.trim()));
/** Display name of the configured PR-description agent. */
const agentName = computed(() => props.meta?.tools.prAgent ?? 'the PR agent');
const agentReady = computed(() => props.meta?.tools.prAgentAvailable !== false);
const ghReady = computed(() => props.meta?.tools.gh !== false && props.meta?.tools.ghAuthed !== false);

async function run(label: string, action: () => Promise<CombinedBranchDetail>): Promise<void> {
  busy.value = label;
  error.value = null;
  notice.value = null;
  try {
    emit('changed', await action());
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

const generate = () => run('describe', () => api.describeBranch(props.branch.branchName));

const save = () =>
  run('save', () =>
    api.updateBranch(props.branch.branchName, {
      prTitle: draft.value.title,
      prBody: draft.value.body,
    }),
  );

async function createPr(): Promise<void> {
  if (dirty.value) {
    // The server opens the PR from the stored description, not the form, so an
    // unsaved edit would silently not appear in the PR.
    await save();
    if (error.value) return;
  }

  busy.value = 'pr';
  error.value = null;
  try {
    const result = await api.createPr(props.branch.branchName, draftDraftPr.value);
    notice.value = result.pushed ? 'Branch pushed and pull request opened.' : 'Pull request opened.';
    emit('changed', result.branch);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = null;
  }
}

async function forget(): Promise<void> {
  if (!confirm(`Forget '${props.branch.branchName}'? The Git branch and any PR are left alone.`)) {
    return;
  }
  busy.value = 'forget';
  try {
    await api.forgetBranch(props.branch.branchName);
    emit('forgotten', props.branch.branchName);
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
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <div class="detail-header">
      <h2 class="mono">{{ branch.branchName }}</h2>
    </div>

    <div class="row" style="flex-wrap: wrap; margin-bottom: 8px">
      <span v-if="branch.prUrl" class="badge verified">PR #{{ branch.prNumber ?? '?' }}</span>
      <span v-else-if="!branch.git.exists" class="badge failed">Branch missing</span>
      <span v-else class="badge in_progress">No PR yet</span>
      <span class="faint">into <code class="mono">{{ base }}</code></span>
      <span class="faint">· combined {{ formatDate(branch.createdAt) }}</span>
      <span class="spacer" />
      <a v-if="branch.prUrl" :href="branch.prUrl" target="_blank" rel="noreferrer">Open on GitHub ↗</a>
      <button class="danger" :disabled="!!busy" @click="forget">Forget</button>
    </div>

    <p v-if="!branch.git.exists" class="banner warn">
      This branch no longer exists locally. It may have been merged and deleted — the
      record is kept for its pull request link.
    </p>

    <!-- ---------------------------------------------------------- contents -->
    <div class="section">
      <h3>Contents</h3>

      <div class="panel">
        <div class="row" style="flex-wrap: wrap; margin-bottom: 10px">
          <strong>{{ branch.git.commits.length }}</strong>
          <span class="faint">commit(s)</span>
          <span class="faint">· {{ branch.git.filesChanged }} file(s) changed</span>
          <span v-if="branch.git.upstream" class="faint">
            · pushed to <code class="mono">{{ branch.git.upstream }}</code>
          </span>
          <span v-else class="faint">· not pushed</span>
        </div>

        <div v-if="branch.tasks.length" class="row" style="flex-wrap: wrap; margin-bottom: 10px">
          <button
            v-for="task in branch.tasks"
            :key="task.ref"
            class="task-chip"
            :title="task.title"
            @click="emit('openTask', task.ref)"
          >
            <span class="mono">{{ task.ref }}</span>
            <span class="badge" :class="task.status">{{ STATUS_LABELS[task.status] }}</span>
            <span class="task-chip-title">{{ task.title }}</span>
          </button>
        </div>
        <p v-else class="faint" style="margin: 0 0 10px">
          {{ branch.taskRefs.length ? 'The tasks behind this branch have since been deleted.'
             : 'No tasks recorded for this branch.' }}
        </p>

        <button v-if="branch.git.commits.length" @click="showCommits = !showCommits">
          {{ showCommits ? 'Hide' : 'Show' }} commits
        </button>

        <ul v-if="showCommits" class="commit-list">
          <li v-for="commit in branch.git.commits" :key="commit.sha">
            <code class="mono faint">{{ commit.shortSha }}</code>
            <span>{{ commit.subject }}</span>
          </li>
        </ul>
      </div>
    </div>

    <!-- ------------------------------------------------------- description -->
    <div class="section">
      <h3>Pull request description</h3>

      <p v-if="!agentReady" class="banner warn">
        The <code class="mono">{{ agentName }}</code> CLI is not on PATH, so a description cannot be
        generated here. You can still write one by hand.
      </p>

      <div class="row" style="margin-bottom: 12px">
        <button
          :disabled="!!busy || !branch.git.commits.length || !agentReady"
          @click="generate"
        >
          {{
            busy === 'describe'
              ? `Asking ${agentName}…`
              : branch.prTitle
                ? `Regenerate with ${agentName}`
                : `Generate with ${agentName}`
          }}
        </button>
        <span class="faint">
          Reads the {{ branch.git.commits.length }} commit(s) on this branch. Takes a minute or two.
        </span>
      </div>

      <p v-if="busy === 'describe'" class="dim">
        {{ agentName }} is reading the commit history — the page will fill in when it answers.
      </p>

      <div class="panel">
        <div class="field">
          <label for="pr-title">Title</label>
          <input id="pr-title" v-model="draft.title" placeholder="Pull request title" />
        </div>
        <div class="field">
          <label for="pr-body">Body (Markdown)</label>
          <textarea id="pr-body" v-model="draft.body" rows="16" class="pr-body" />
        </div>
        <div class="row">
          <button :disabled="!dirty || !!busy" @click="save">
            {{ busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------- pull request -->
    <div class="section">
      <h3>Pull request</h3>

      <p v-if="branch.prUrl" class="panel">
        Opened as
        <a :href="branch.prUrl" target="_blank" rel="noreferrer" class="mono">{{ branch.prUrl }}</a>
      </p>

      <template v-else>
        <p v-if="!ghReady" class="banner warn">
          The <code class="mono">gh</code> CLI is missing or not authenticated
          (<code class="mono">gh auth login</code>), so the pull request cannot be opened here.
        </p>

        <div class="panel">
          <label class="combine-close">
            <input v-model="draftDraftPr" type="checkbox" /> Open as a draft
          </label>
          <p class="faint">
            Targets <code class="mono">{{ base }}</code>.
            <template v-if="!branch.git.upstream">
              The branch has no upstream yet, so it is pushed to <code class="mono">origin</code> first.
            </template>
          </p>
          <button
            class="primary"
            :disabled="!!busy || !hasDescription || !branch.git.exists || !ghReady"
            @click="createPr"
          >
            {{ busy === 'pr' ? 'Opening…' : 'Create pull request' }}
          </button>
          <p v-if="!hasDescription" class="faint">A title is required before opening the PR.</p>
        </div>
      </template>
    </div>
  </section>
</template>
