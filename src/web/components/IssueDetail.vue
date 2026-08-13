<script setup lang="ts">
import { computed, ref } from 'vue';
import { ISSUE_SOURCE_LABELS, type IssueDetail } from '@shared/types';
import AgentRunDialog from './AgentRunDialog.vue';
import MarkdownBlock from './MarkdownBlock.vue';

const props = defineProps<{ issue: IssueDetail }>();
const emit = defineEmits<{ back: [] }>();

const showRaw = ref(false);
const investigating = ref(false);

const sourceLabel = computed(() => ISSUE_SOURCE_LABELS[props.issue.source] ?? props.issue.source);

/**
 * Azure DevOps returns descriptions as HTML, GitHub as Markdown.
 *
 * The HTML is not rendered as HTML: it comes from outside this app, and there is
 * no sanitiser here worth trusting with it. Block tags become line breaks and
 * everything else is dropped, leaving text that goes through the same escaping
 * Markdown renderer — readable, and incapable of executing anything.
 */
function htmlToMarkdownish(html: string): string {
  return html
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6])\s*>/gi, '\n\n')
    // List items close with a single newline: a blank line between them would
    // end the list and start a new one for every bullet.
    .replace(/<\s*\/\s*(li|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The Markdown source to render — and the text Copy hands back. */
const body = computed(() =>
  props.issue.bodyFormat === 'html' ? htmlToMarkdownish(props.issue.body) : props.issue.body,
);

const raw = computed(() => JSON.stringify(props.issue.raw, null, 2));

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

async function copyRaw(): Promise<void> {
  try {
    await navigator.clipboard.writeText(raw.value);
  } catch {
    // Clipboard access can be refused; the JSON is on screen to select.
  }
}
</script>

<template>
  <section class="detail issue-detail">
    <div class="row" style="margin-bottom: 12px">
      <button @click="emit('back')">← All issues</button>
      <span class="spacer" />
      <!-- Runs /plan-tasks against the issue itself: the agent reads the
           reporter's own words out of the notes folder and files what it finds
           as tasks. -->
      <button class="primary" @click="investigating = true">Investigate</button>
      <a v-if="issue.url" class="issue-open" :href="issue.url" target="_blank" rel="noreferrer noopener">
        Open in {{ sourceLabel }} ↗
      </a>
    </div>

    <AgentRunDialog
      v-if="investigating"
      command="plan-tasks"
      :target="issue.key === '?' ? '' : issue.key"
      subject-kind="issue"
      :subject-ref="issue.id"
      :subject-title="issue.title"
      @close="investigating = false"
    />

    <div class="row" style="flex-wrap: wrap; margin-bottom: 6px">
      <span class="source-badge">{{ sourceLabel }}</span>
      <span class="mono faint">{{ issue.key }}</span>
      <span class="badge" :class="issue.state === 'open' ? 'in_progress' : 'verified'">
        {{ issue.stateLabel }}
      </span>
      <span v-if="issue.kind" class="issue-kind">{{ issue.kind }}</span>
      <span v-if="issue.container" class="faint">{{ issue.container }}</span>
    </div>

    <h2 class="issue-title">{{ issue.title }}</h2>

    <div v-if="issue.labels.length" class="issue-labels" style="margin-bottom: 14px">
      <span
        v-for="label in issue.labels"
        :key="label.name"
        class="issue-label"
        :style="label.color ? { '--label': label.color } : undefined"
        :title="label.description ?? undefined"
      >
        {{ label.name }}
      </span>
    </div>

    <!-- ---------------------------------------------------------- details -->
    <div class="section">
      <h3>Details</h3>
      <div class="panel issue-fields">
        <div><span class="faint">Author</span><span>{{ issue.author?.name ?? '—' }}</span></div>
        <div>
          <span class="faint">Assigned</span>
          <span>{{ issue.assignees.map((person) => person.name).join(', ') || 'Unassigned' }}</span>
        </div>
        <div><span class="faint">Created</span><span>{{ formatDate(issue.createdAt) }}</span></div>
        <div><span class="faint">Updated</span><span>{{ formatDate(issue.updatedAt) }}</span></div>
        <div v-if="issue.closedAt"><span class="faint">Closed</span><span>{{ formatDate(issue.closedAt) }}</span></div>
        <div v-if="issue.milestone"><span class="faint">Milestone</span><span>{{ issue.milestone }}</span></div>
        <div v-if="issue.commentCount !== null">
          <span class="faint">Comments</span><span>{{ issue.commentCount }}</span>
        </div>
        <div>
          <span class="faint">Fetched</span>
          <span>{{ issue.fetchedAt ? formatDate(issue.fetchedAt) : 'unknown' }}</span>
        </div>
        <div class="issue-file">
          <span class="faint">File</span><span class="mono">{{ issue.path }}</span>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------ description -->
    <div class="section">
      <h3>Description</h3>
      <!-- The provider's HTML is flattened to Markdown-ish text before it gets
           here, never passed through — so Copy hands back the text on screen. -->
      <MarkdownBlock v-if="issue.body.trim()" :source="body" />
      <p v-else class="empty">No description.</p>
    </div>

    <!-- -------------------------------------------------------------- raw -->
    <div class="section">
      <h3>
        <button class="disclosure" @click="showRaw = !showRaw">
          <span class="chevron" :class="{ open: showRaw }">›</span>
          Raw JSON
        </button>
      </h3>
      <div v-if="showRaw" class="panel">
        <div class="row" style="margin-bottom: 8px">
          <span class="faint">Everything the provider sent, as it was stored.</span>
          <span class="spacer" />
          <button @click="copyRaw">Copy</button>
        </div>
        <pre class="issue-raw mono">{{ raw }}</pre>
      </div>
    </div>
  </section>
</template>
