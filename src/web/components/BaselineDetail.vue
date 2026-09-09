<script setup lang="ts">
import { computed, ref } from "vue"
import type { BaselineReport, BaselineScenario } from "@shared/types"
import { api } from "../api"
import ComparisonCard from "./ComparisonCard.vue"

/**
 * How the app looks now against the last state anyone approved.
 *
 * The task checkpoints elsewhere in this app answer "did my change move
 * anything?" — scoped to one task, discarded when it closes. This answers "does
 * the app still look the way we agreed?", which is a question about the app
 * rather than about a task, and the drift it reports accumulates whether or not
 * anyone was working.
 *
 * Everything here is read from aio-vr's own files and written by aio-vr's own
 * commands. This view never decides what a baseline is.
 */
const props = defineProps<{ report: BaselineReport }>()
const emit = defineEmits<{ changed: [BaselineReport] }>()

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const filter = ref<"drifted" | "all">("drifted")

/**
 * Drifted first, and by how much.
 *
 * A page opened to look at drift should not open on twenty unchanged rows, and
 * within the drift the biggest difference is the one most likely to be a
 * mistake rather than an intended tweak. `failed` sorts above `changed`: a
 * scenario that could not render is a broken test, not a visual difference.
 */
const RANK: Record<string, number> = {
  failed: 0,
  changed: 1,
  "new-baseline": 2,
  unchanged: 3,
}

const sorted = computed(() =>
  [...props.report.scenarios].sort(
    (left, right) =>
      (RANK[left.status] ?? 9) - (RANK[right.status] ?? 9) ||
      (right.percentChanged ?? 0) - (left.percentChanged ?? 0) ||
      left.scenario.localeCompare(right.scenario),
  ),
)

const drifted = computed(() =>
  sorted.value.filter(
    (one) => one.status === "changed" || one.status === "failed",
  ),
)

const shown = computed(() =>
  filter.value === "drifted" ? drifted.value : sorted.value,
)

/** Open cards, by scenario name. Owned here rather than inside the card so the
 *  expand-all / collapse-all control has something to write to, and so several
 *  can be open at once — comparing two drifts means seeing both. */
const openScenarios = ref(new Set<string>())

function setOpen(scenario: string, open: boolean): void {
  // Replaced rather than mutated — a Set mutation is not a reactive write.
  const next = new Set(openScenarios.value)
  if (open) next.add(scenario)
  else next.delete(scenario)
  openScenarios.value = next
}

/** Judged against what is on screen, not the whole suite: with the Drifted
 *  filter on, "expand all" means the rows you can actually see. */
const allOpen = computed(
  () =>
    !!shown.value.length &&
    shown.value.every((one) => openScenarios.value.has(one.scenario)),
)

function toggleAll(): void {
  openScenarios.value = allOpen.value
    ? new Set()
    : new Set(shown.value.map((one) => one.scenario))
}

/** Approved *and* still different: someone signed this off, so it is drift that
 *  is expected until the next run re-baselines it. */
const approvedDrift = computed(
  () => drifted.value.filter((one) => one.approved).length,
)

const generated = computed(() =>
  props.report.generatedAt
    ? new Date(props.report.generatedAt).toLocaleString()
    : null,
)

async function run(
  label: string,
  action: () => Promise<BaselineReport>,
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

/** A run's non-zero exit means "something drifted", which is this page's whole
 *  subject — so it is reported as a notice, never as a failure. */
async function rerun(scenarios: string[], label: string): Promise<void> {
  busy.value = label
  error.value = null
  notice.value = null
  try {
    const result = await api.runBaselines(scenarios)
    emit("changed", result.report)
    if (result.exitCode !== 0) {
      const failed = result.report.scenarios.filter(
        (one) => one.status === "failed",
      )
      notice.value = failed.length
        ? `${failed.length} scenario(s) could not be captured: ${failed
            .map((one) => one.scenario)
            .join(", ")}.`
        : "Finished — some scenarios differ from their baselines."
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = null
  }
}

/** Approving overwrites the reference every later run is measured against, so
 *  it asks first and names what is being accepted. */
function approve(scenario: BaselineScenario): void {
  const amount =
    scenario.percentChanged === null
      ? "this difference"
      : `${scenario.percentChanged.toFixed(2)}%`
  if (
    !confirm(
      `Make the current capture of '${scenario.scenario}' the new baseline?\n\n` +
        `${amount} of pixels differ from the approved image. Later runs will be measured ` +
        "against the new one.",
    )
  ) {
    return
  }
  void run(`approve-${scenario.scenario}`, () =>
    api.approveBaseline(scenario.scenario),
  )
}
</script>

<template>
  <section class="detail">
    <p v-if="error" class="banner">{{ error }}</p>
    <p v-if="notice" class="banner warn">{{ notice }}</p>

    <div class="detail-header">
      <h2>Baselines</h2>
    </div>

    <div class="detail-meta">
      <span v-if="generated" class="faint">Last run {{ generated }}</span>
      <span v-else class="faint">Never run</span>
      <span class="spacer" />
      <button
        :disabled="!!busy || !report.available"
        :title="
          report.available
            ? 'Re-run every scenario against its baseline. Drives a real browser — minutes, not seconds.'
            : 'aio-vr is not on PATH'
        "
        @click="rerun([], 'run-all')"
      >
        {{ busy === "run-all" ? "Running…" : "Run all" }}
      </button>
    </div>

    <p v-if="!report.available" class="banner warn">
      The <code class="mono">aio-vr</code> executable is not on PATH, so nothing
      can be re-run or approved here. The results below are the last ones it
      wrote.
    </p>

    <!-- ------------------------------------------------------------ never -->
    <p v-if="!report.hasRun" class="empty">
      aio-vr has not run here yet, so there is nothing to compare against. Run
      the suite once to record a baseline for every scenario —
      <code class="mono">aio-vr run</code>, or the button above.
      <br />
      Results are read from <code class="mono">{{ report.resultsPath }}</code
      >.
    </p>

    <template v-else>
      <!-- ----------------------------------------------------------- tally -->
      <div class="section">
        <div class="panel">
          <div class="row" style="flex-wrap: wrap">
            <span
              v-for="(count, status) in report.totals"
              :key="status"
              class="task-chip"
            >
              <span class="badge" :class="status">{{ status }}</span>
              <strong>{{ count }}</strong>
            </span>
          </div>
          <p v-if="approvedDrift" class="faint" style="margin: 10px 0 0">
            {{ approvedDrift }} of the differences
            {{ approvedDrift === 1 ? "has" : "have" }}
            already been approved — the next full run promotes
            {{ approvedDrift === 1 ? "it" : "them" }} to the baseline.
          </p>
        </div>
      </div>

      <!-- ------------------------------------------------------- scenarios -->
      <div class="section">
        <div class="section-head">
          <h3>
            {{ filter === "drifted" ? "Drifted" : "All scenarios" }}
            ({{ shown.length }})
          </h3>
          <span class="spacer" />
          <div class="modes" role="group" aria-label="Which scenarios to show">
            <button
              :class="{ active: filter === 'drifted' }"
              @click="filter = 'drifted'"
            >
              Drifted ({{ drifted.length }})
            </button>
            <button
              :class="{ active: filter === 'all' }"
              @click="filter = 'all'"
            >
              All ({{ report.scenarios.length }})
            </button>
          </div>
          <button v-if="shown.length" @click="toggleAll">
            {{ allOpen ? "Collapse all" : "Expand all" }}
          </button>
        </div>

        <p v-if="!shown.length" class="empty">
          {{
            filter === "drifted"
              ? "Nothing has drifted. Every scenario matches its approved baseline."
              : "No scenarios in the last run."
          }}
        </p>

        <div
          v-for="scenario in shown"
          :key="scenario.scenario"
          class="baseline-row"
        >
          <!-- The same card the task checkpoints use, with the reference
               renamed: here the left-hand image is the approved baseline. -->
          <ComparisonCard
            :comparison="scenario"
            before-label="Baseline"
            after-label="Current"
            :open="openScenarios.has(scenario.scenario)"
            @update:open="setOpen(scenario.scenario, $event)"
          />

          <div class="row baseline-actions">
            <span
              v-if="scenario.approved"
              class="faint"
              :title="scenario.approvedAt ?? ''"
            >
              ✓ approved{{
                scenario.statusAtApproval
                  ? ` while ${scenario.statusAtApproval}`
                  : ""
              }}
            </span>
            <span v-if="scenario.threshold !== null" class="faint">
              threshold {{ scenario.threshold }}%
            </span>
            <span v-if="scenario.scenarioPath" class="mono faint">{{
              scenario.scenarioPath
            }}</span>
            <span class="spacer" />
            <button
              :disabled="!!busy || !report.available"
              :title="`Re-run only ${scenario.scenario}`"
              @click="rerun([scenario.scenario], `run-${scenario.scenario}`)"
            >
              {{ busy === `run-${scenario.scenario}` ? "Running…" : "Re-run" }}
            </button>
            <!-- Only offered where it means something: approving an unchanged
                 scenario would rewrite a reference that already matches. -->
            <button
              v-if="scenario.status === 'changed'"
              class="primary"
              :disabled="!!busy || !report.available || !scenario.afterPath"
              :title="`Make the current capture of ${scenario.scenario} the new baseline`"
              @click="approve(scenario)"
            >
              {{
                busy === `approve-${scenario.scenario}`
                  ? "Approving…"
                  : "Approve"
              }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
