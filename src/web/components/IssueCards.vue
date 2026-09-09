<script setup lang="ts">
import { ISSUE_SOURCE_LABELS, type IssueSummary } from "@shared/types"

/**
 * The issue board: one card per issue, whatever provider it came from.
 *
 * A card shows only what every provider has — key, title, state, who it is on,
 * when it last moved — so a GitHub issue and an Azure DevOps work item sit in
 * the same grid without either looking like a special case. The `source` badge
 * is the only thing that distinguishes them at this level.
 */
defineProps<{
  issues: IssueSummary[]
  loading: boolean
  filtered: boolean
  notesDir: string | null
}>()
const emit = defineEmits<{ open: [string] }>()

const sourceLabel = (source: string) => ISSUE_SOURCE_LABELS[source] ?? source

/** Dates on a card are relative — "how stale is this" is the question a board
 *  answers, and an exact timestamp is on the detail view. */
function ago(value: string | null): string {
  if (!value) return ""
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000)
  if (Number.isNaN(days)) return ""
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

const initials = (name: string) =>
  name
    .replace(/[^a-z0-9 -]/gi, "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("")
</script>

<template>
  <section class="detail issue-board">
    <div class="issue-grid">
      <button
        v-for="issue in issues"
        :key="issue.id"
        class="issue-card"
        :class="[`source-${issue.source}`, issue.state]"
        @click="emit('open', issue.id)"
      >
        <div class="row">
          <span class="source-badge">{{ sourceLabel(issue.source) }}</span>
          <span class="mono faint">{{ issue.key }}</span>
          <span
            class="badge"
            :class="issue.state === 'open' ? 'in_progress' : 'verified'"
          >
            {{ issue.stateLabel }}
          </span>
          <span class="spacer" />
          <span class="faint">{{ ago(issue.updatedAt) }}</span>
        </div>

        <h3 class="issue-card-title">{{ issue.title }}</h3>

        <p v-if="issue.container || issue.kind" class="faint issue-card-origin">
          <span v-if="issue.kind" class="issue-kind">{{ issue.kind }}</span>
          <span v-if="issue.container">{{ issue.container }}</span>
        </p>

        <p v-if="issue.excerpt" class="issue-card-excerpt dim">
          {{ issue.excerpt }}
        </p>

        <div v-if="issue.labels.length" class="issue-labels">
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

        <div class="row issue-card-foot">
          <div v-if="issue.assignees.length" class="avatars">
            <span
              v-for="person in issue.assignees.slice(0, 3)"
              :key="person.name"
              class="avatar"
              :title="person.name"
            >
              <img
                v-if="person.avatarUrl"
                :src="person.avatarUrl"
                :alt="person.name"
              />
              <template v-else>{{ initials(person.name) }}</template>
            </span>
          </div>
          <span v-else class="faint">Unassigned</span>
          <span class="spacer" />
          <span v-if="issue.commentCount" class="faint"
            >{{ issue.commentCount }} comment(s)</span
          >
        </div>
      </button>
    </div>

    <p v-if="!loading && !issues.length" class="empty">
      <template v-if="filtered">Nothing matches those filters.</template>
      <template v-else>
        No issue files found.
        <span v-if="notesDir">
          Drop a provider's JSON into
          <span class="mono">{{ notesDir }}</span> and it appears here.
        </span>
      </template>
    </p>
  </section>
</template>
