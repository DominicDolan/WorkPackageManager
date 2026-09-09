<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue"
import {
  STATUS_LABELS,
  type CheckRun,
  type CombinedBranchDetail,
} from "@shared/types"
import { api, type Meta } from "../api"
import MarkdownBlock from "./MarkdownBlock.vue"

const props = defineProps<{ branch: CombinedBranchDetail; meta: Meta | null }>()
const emit = defineEmits<{
  changed: [CombinedBranchDetail]
  forgotten: [string]
  openTask: [string]
  continueCombine: [string]
}>()

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const draft = ref({ title: "", body: "" })
const branchSettings = ref({ name: "", base: "", remote: "" })
const draftDraftPr = ref(false)
const bodyMode = ref<"write" | "read">("write")
const showCommits = ref(false)

/** The editable copy is reseeded whenever the server hands back a new version —
 *  including right after a generation, which is how the result lands in the form. */
watch(
  () => [props.branch.branchName, props.branch.updatedAt] as const,
  () => {
    draft.value = {
      title: props.branch.prTitle ?? "",
      body: props.branch.prBody ?? "",
    }
    branchSettings.value = {
      name: props.branch.branchName,
      base: props.branch.baseBranch ?? "",
      remote: props.branch.remoteBranch ?? "",
    }
    error.value = null
    notice.value = null
  },
  { immediate: true },
)

const dirty = computed(
  () =>
    draft.value.title !== (props.branch.prTitle ?? "") ||
    draft.value.body !== (props.branch.prBody ?? ""),
)

const base = computed(() => props.branch.baseBranch ?? "—")
/** A branch built from a single task was prepared, not combined. Both are
 *  delivery branches and behave identically from here on. */
const single = computed(() => props.branch.taskRefs.length === 1)
const hasDescription = computed(() => Boolean(draft.value.title.trim()))
/** Display name of the configured PR-description agent. */
const agentName = computed(() => props.meta?.tools.prAgent ?? "the PR agent")
const agentReady = computed(() => props.meta?.tools.prAgentAvailable !== false)
const ghReady = computed(
  () => props.meta?.tools.gh !== false && props.meta?.tools.ghAuthed !== false,
)

/* ------------------------------------------------------------------ checks */

const checksConfigured = computed(() => (props.meta?.tools.checkCount ?? 0) > 0)
const report = computed(() => props.branch.checks)
/** Stale by commit: a report describes the code that was on the branch when it
 *  ran, and one more commit makes it a statement about something else. */
const checksStale = computed(() => {
  const head = props.branch.git.commits.at(-1)?.sha
  return Boolean(report.value?.headSha && head && report.value.headSha !== head)
})
/** What the PR button says is wrong, mirroring the server's own gate. */
const checksBlocking = computed(() => {
  if (!checksConfigured.value) return null
  if (!report.value) return "Checks have not been run on this branch yet."
  if (!report.value.passed) return "Checks failed."
  if (checksStale.value)
    return "The branch has new commits since the checks last ran."
  return null
})
/* A failure's output is the reason anyone opened this panel, so it starts
   expanded; a pass starts collapsed. Both are one click from the other, and the
   two lists record only the departures from that default. */
const collapsed = ref<string[]>([])
const expanded = ref<string[]>([])
const failing = (check: CheckRun) =>
  check.status !== "passed" && check.status !== "skipped"
const isOpen = (check: CheckRun) =>
  failing(check)
    ? !collapsed.value.includes(check.name)
    : expanded.value.includes(check.name)
const toggleCheck = (check: CheckRun) => {
  const list = failing(check) ? collapsed : expanded
  list.value = list.value.includes(check.name)
    ? list.value.filter((entry) => entry !== check.name)
    : [...list.value, check.name]
}

/** Set while a run is in flight — the server starts checks and returns, because
 *  a suite outlives any request worth holding open. */
const running = computed(() => props.branch.checksRunning)

async function runChecks(): Promise<void> {
  error.value = null
  try {
    emit("changed", await api.runChecks(props.branch.branchName))
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

/* Poll while a run is going. The server announces the finished report over the
   live-update stream, but that says nothing about which check is running now,
   which is the whole content of a five-minute wait. */
let poll: ReturnType<typeof setInterval> | undefined
watch(
  () => Boolean(props.branch.checksRunning),
  (active) => {
    clearInterval(poll)
    if (!active) return
    poll = setInterval(() => {
      api
        .getBranch(props.branch.branchName)
        .then((branch) => emit("changed", branch))
        .catch(() => {
          // A poll that fails changes nothing: the next one is two seconds away,
          // and the run is happening on the server either way.
        })
    }, 2000)
  },
  { immediate: true },
)
onUnmounted(() => clearInterval(poll))
const checkLabel: Record<string, string> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  timed_out: "timed out",
  error: "error",
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`

async function run(
  label: string,
  action: () => Promise<CombinedBranchDetail>,
): Promise<void> {
  busy.value = label
  error.value = null
  notice.value = null
  try {
    emit("changed", await action())
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

const generate = () =>
  run("describe", () => api.describeBranch(props.branch.branchName))

const saveBranchSettings = () =>
  run("branch-settings", () =>
    api.updateBranch(props.branch.branchName, {
      branchName: branchSettings.value.name,
      baseBranch: branchSettings.value.base,
      remoteBranch: branchSettings.value.remote,
    }),
  )

const save = () =>
  run("save", () =>
    api.updateBranch(props.branch.branchName, {
      prTitle: draft.value.title,
      prBody: draft.value.body,
    }),
  )

async function createPr(force = false): Promise<void> {
  if (dirty.value) {
    // The server opens the PR from the stored description, not the form, so an
    // unsaved edit would silently not appear in the PR.
    await save()
    if (error.value) return
  }

  busy.value = "pr"
  error.value = null
  try {
    const result = await api.createPr(
      props.branch.branchName,
      draftDraftPr.value,
      force,
    )
    notice.value = result.pushed
      ? "Branch pushed and pull request opened."
      : "Pull request opened."
    emit("changed", result.branch)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

async function forget(): Promise<void> {
  if (
    !confirm(
      `Forget '${props.branch.branchName}'? The Git branch and any PR are left alone.`,
    )
  ) {
    return
  }
  busy.value = "forget"
  try {
    await api.forgetBranch(props.branch.branchName)
    emit("forgotten", props.branch.branchName)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

const formatDate = (value: string) => new Date(value).toLocaleString()
</script>

<template>
  <section class="detail">
    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner ok">{{ notice }}</p>

    <div class="detail-header">
      <h2 class="mono">{{ branch.branchName }}</h2>
    </div>

    <div class="row" style="flex-wrap: wrap; margin-bottom: 8px">
      <span v-if="branch.prUrl" class="badge verified"
        >PR #{{ branch.prNumber ?? "?" }}</span
      >
      <span v-else-if="!branch.git.exists" class="badge failed"
        >Branch missing</span
      >
      <span v-else class="badge in_progress">No PR yet</span>
      <span class="faint"
        >into <code class="mono">{{ base }}</code></span
      >
      <span class="faint"
        >· {{ single ? "prepared" : "combined" }}
        {{ formatDate(branch.createdAt) }}</span
      >
      <span class="spacer" />
      <a
        v-if="branch.prUrl"
        :href="branch.prUrl"
        target="_blank"
        rel="noreferrer"
        >Open on GitHub ↗</a
      >
      <button class="danger" :disabled="!!busy" @click="forget">Forget</button>
    </div>

    <div class="section">
      <h3>Branch settings</h3>
      <div class="panel">
        <div class="field">
          <label for="branch-name">Branch name</label
          ><input id="branch-name" v-model="branchSettings.name" />
        </div>
        <div class="field">
          <label for="branch-remote">Remote branch name</label
          ><input
            id="branch-remote"
            v-model="branchSettings.remote"
            :placeholder="branchSettings.name"
          />
        </div>
        <p class="faint">
          Push and open the pull request under a different branch name on the
          remote. Leave blank to push under the same name as the local branch.
        </p>
        <div class="field">
          <label for="branch-base">PR target branch</label
          ><input
            id="branch-base"
            v-model="branchSettings.base"
            placeholder="master"
          />
        </div>
        <p class="faint">
          The target branch is the branch the pull request will be opened into.
          It does not change the commits already picked onto this branch.
        </p>
        <button
          :disabled="
            !!busy || !branchSettings.name.trim() || !branchSettings.base.trim()
          "
          @click="saveBranchSettings"
        >
          {{ busy === "branch-settings" ? "Saving…" : "Save branch settings" }}
        </button>
      </div>
    </div>

    <div v-if="branch.combineState === 'conflict'" class="banner warn">
      <strong
        >{{ single ? "Cherry-pick paused" : "Combine paused" }}: resolve the Git
        conflict.</strong
      >
      <p>
        Resolve and stage the conflicted files on
        <code class="mono">{{ branch.branchName }}</code
        >, then continue the merge.
      </p>
      <button
        class="primary"
        @click="emit('continueCombine', branch.branchName)"
      >
        Continue
      </button>
    </div>

    <p v-if="!branch.git.exists" class="banner warn">
      This branch no longer exists locally. It may have been merged and deleted
      — the record is kept for its pull request link.
    </p>

    <!-- ---------------------------------------------------------- contents -->
    <div class="section">
      <h3>Contents</h3>

      <div class="panel">
        <div class="row" style="flex-wrap: wrap; margin-bottom: 10px">
          <strong>{{ branch.git.commits.length }}</strong>
          <span class="faint">commit(s)</span>
          <span class="faint"
            >· {{ branch.git.filesChanged }} file(s) changed</span
          >
          <span v-if="branch.git.upstream" class="faint">
            · pushed to <code class="mono">{{ branch.git.upstream }}</code>
          </span>
          <span v-else class="faint">· not pushed</span>
        </div>

        <div
          v-if="branch.tasks.length"
          class="row"
          style="flex-wrap: wrap; margin-bottom: 10px"
        >
          <button
            v-for="task in branch.tasks"
            :key="task.ref"
            class="task-chip"
            :title="task.title"
            @click="emit('openTask', task.ref)"
          >
            <span class="mono">{{ task.ref }}</span>
            <span class="badge" :class="task.status">{{
              STATUS_LABELS[task.status]
            }}</span>
            <span class="task-chip-title">{{ task.title }}</span>
          </button>
        </div>
        <p v-else class="faint" style="margin: 0 0 10px">
          {{
            branch.taskRefs.length
              ? "The tasks behind this branch have since been deleted."
              : "No tasks recorded for this branch."
          }}
        </p>

        <button
          v-if="branch.git.commits.length"
          @click="showCommits = !showCommits"
        >
          {{ showCommits ? "Hide" : "Show" }} commits
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
      <div class="section-head">
        <h3>Pull request description</h3>
        <span class="spacer" />
        <!-- The body is Markdown that GitHub will render, and most of it was
             written by an agent — so being able to read it as GitHub will show
             it, before opening the PR, is the point of the toggle. -->
        <div class="modes" role="group" aria-label="Description view">
          <button
            :class="{ active: bodyMode === 'write' }"
            @click="bodyMode = 'write'"
          >
            Write
          </button>
          <button
            :class="{ active: bodyMode === 'read' }"
            @click="bodyMode = 'read'"
          >
            Read
          </button>
        </div>
      </div>

      <p v-if="!agentReady" class="banner warn">
        The <code class="mono">{{ agentName }}</code> CLI is not on PATH, so a
        description cannot be generated here. You can still write one by hand.
      </p>

      <div class="row" style="margin-bottom: 12px">
        <button
          :disabled="!!busy || !branch.git.commits.length || !agentReady"
          @click="generate"
        >
          {{
            busy === "describe"
              ? `Asking ${agentName}…`
              : branch.prTitle
                ? `Regenerate with ${agentName}`
                : `Generate with ${agentName}`
          }}
        </button>
        <span class="faint">
          Reads the {{ branch.git.commits.length }} commit(s) on this branch.
          Takes a minute or two.
        </span>
      </div>

      <p v-if="busy === 'describe'" class="dim">
        {{ agentName }} is reading the commit history — the page will fill in
        when it answers.
      </p>

      <div class="panel">
        <div class="field">
          <label for="pr-title">Title</label>
          <input
            id="pr-title"
            v-model="draft.title"
            placeholder="Pull request title"
          />
        </div>
        <div class="field">
          <label for="pr-body">Body (Markdown)</label>
          <textarea
            v-if="bodyMode === 'write'"
            id="pr-body"
            v-model="draft.body"
            rows="16"
            class="pr-body"
          />
          <!-- Previews the draft rather than the saved body: what you are
               checking is what you just edited. -->
          <MarkdownBlock v-else-if="draft.body.trim()" :source="draft.body" />
          <p v-else class="empty">Nothing written yet.</p>
        </div>
        <div class="row">
          <button :disabled="!dirty || !!busy" @click="save">
            {{ busy === "save" ? "Saving…" : dirty ? "Save" : "Saved" }}
          </button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------------ checks -->
    <div v-if="checksConfigured" class="section">
      <h3>Checks</h3>

      <div class="row" style="margin-bottom: 12px">
        <button
          :disabled="!!busy || !!running || !branch.git.exists"
          @click="runChecks"
        >
          {{
            running ? "Running…" : report ? "Run checks again" : "Run checks"
          }}
        </button>
        <span class="faint">
          {{ meta?.tools.checkCount }} configured command(s) — typecheck, lint,
          tests. Takes as long as they take.
        </span>
      </div>

      <p v-if="running" class="banner ok">
        Running <strong>{{ running.current ?? "the first check" }}</strong>
        <template v-if="running.total">
          — {{ running.done + 1 }} of {{ running.total }}</template
        >. It keeps going whether or not this page is open.
      </p>

      <p v-else-if="!report" class="empty">
        Not run on this branch yet. The pull request is blocked until they pass.
      </p>

      <template v-else>
        <p class="faint">
          Ran {{ formatDate(report.ranAt) }} against
          <code class="mono">{{ report.base }}</code
          >.
          <template
            v-if="
              report.ranOnBranch && report.ranOnBranch !== branch.branchName
            "
          >
            <strong>The working tree was on '{{ report.ranOnBranch }}'</strong>,
            not this branch, so this result describes that tree.
          </template>
        </p>
        <p v-if="checksStale" class="banner warn">
          The branch has new commits since this ran — the result is stale.
        </p>

        <ul class="checks">
          <li v-for="check in report.checks" :key="check.name">
            <button class="check-head" @click="toggleCheck(check)">
              <span class="check-status" :class="check.status">{{
                checkLabel[check.status]
              }}</span>
              <span class="check-name">{{ check.name }}</span>
              <span class="faint mono">{{ check.command.join(" ") }}</span>
              <span v-if="check.durationMs" class="faint">{{
                seconds(check.durationMs)
              }}</span>
            </button>
            <p v-if="check.reason" class="faint check-reason">
              {{ check.reason }}
            </p>
            <pre v-if="check.output && isOpen(check)" class="check-output">{{
              check.output
            }}</pre>
          </li>
        </ul>
      </template>
    </div>

    <!-- ------------------------------------------------------- pull request -->
    <div class="section">
      <h3>Pull request</h3>

      <p v-if="branch.prUrl" class="panel">
        Opened as
        <a :href="branch.prUrl" target="_blank" rel="noreferrer" class="mono">{{
          branch.prUrl
        }}</a>
      </p>

      <template v-else>
        <p v-if="!ghReady" class="banner warn">
          The <code class="mono">gh</code> CLI is missing or not authenticated
          (<code class="mono">gh auth login</code>), so the pull request cannot
          be opened here.
        </p>

        <div class="panel">
          <label class="combine-close">
            <input v-model="draftDraftPr" type="checkbox" /> Open as a draft
          </label>
          <p class="faint">
            Targets <code class="mono">{{ base }}</code
            >.
            <template v-if="!branch.git.upstream">
              The branch has no upstream yet, so it is pushed to
              <code class="mono">origin</code> first.
            </template>
          </p>
          <button
            class="primary"
            :disabled="
              !!busy ||
              !hasDescription ||
              !branch.git.exists ||
              !ghReady ||
              !!checksBlocking
            "
            @click="createPr()"
          >
            {{ busy === "pr" ? "Opening…" : "Create pull request" }}
          </button>
          <p v-if="!hasDescription" class="faint">
            A title is required before opening the PR.
          </p>
          <template v-if="checksBlocking">
            <p class="faint">{{ checksBlocking }}</p>
            <!-- The override is deliberate: a check can be broken on master, or
                 irrelevant to a docs-only branch, and a gate with no way past it
                 gets worked around instead of used. -->
            <button
              :disabled="
                !!busy || !hasDescription || !branch.git.exists || !ghReady
              "
              @click="createPr(true)"
            >
              Open anyway, without passing checks
            </button>
          </template>
        </div>
      </template>
    </div>
  </section>
</template>
