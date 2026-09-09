<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import {
  groupTasks,
  MAX_ESTIMATE_UNITS,
  STATUS_LABELS,
  type Task,
  type TaskGroup,
  type TaskGroupSummary,
} from "@shared/types"
import { api } from "../api"
import { useSchedule, type ScheduledTask } from "../useSchedule"
import MarkdownBlock from "./MarkdownBlock.vue"

const props = defineProps<{
  tasks: Task[]
  /** Every group there is — the plan draws a band per group, and offers them
   *  as a filter. */
  groups: TaskGroupSummary[]
  /** Highlighted row — the task selected over in the list view. */
  selectedRef: string | null
}>()

const emit = defineEmits<{
  (event: "open-task", ref: string): void
  /** An estimate was saved; the list this view was handed is now stale. */
  (event: "changed"): void
}>()

const error = ref<string | null>(null)
const saving = ref<string | null>(null)

/* ------------------------------------------------------------- what is on it */

/** Closed work is history, not plan — but it is one click away, because a chain
 *  reads oddly when the thing everything hangs off has vanished. */
const showClosed = ref(false)
const tagFilter = ref("")
/** A group's ref, or `'none'` for the tasks in no group. */
const groupFilter = ref("")
/** Whether the plan is drawn in bands. Off, it is one flat chart — which is
 *  what you want when the question is about the critical path rather than about
 *  who owns what. */
const showGroups = ref(true)

const tags = computed(() =>
  [...new Set(props.tasks.flatMap((task) => task.tags))].sort((a, b) =>
    a.localeCompare(b),
  ),
)

const planned = computed(() =>
  props.tasks.filter(
    (task) =>
      (showClosed.value || task.status !== "closed") &&
      (!tagFilter.value || task.tags.includes(tagFilter.value)) &&
      (!groupFilter.value ||
        (groupFilter.value === "none"
          ? !task.groupRef
          : task.groupRef?.toLowerCase() === groupFilter.value.toLowerCase())),
  ),
)

const { rows, totalUnits } = useSchedule(planned)

/* -------------------------------------------------------------- the bands */

/**
 * The chart's rows, headings included.
 *
 * The plan is laid out by row index, so a heading has to *be* a row rather than
 * something drawn between two — that is what keeps the bars, the links and the
 * bands from drifting apart when a group is added or the filter changes.
 *
 * Sections are ordered by their earliest task, so the band a group gets is
 * where its work actually is on the plan rather than wherever the group was
 * created.
 */
type LayoutRow =
  | {
      kind: "group"
      key: string
      group: TaskGroup | null
      count: number
      start: number
      finish: number
    }
  | { kind: "task"; key: string; row: ScheduledTask; group: TaskGroup | null }

const banded = computed(() => showGroups.value && props.groups.length > 0)

const layout = computed<LayoutRow[]>(() => {
  if (!banded.value) {
    return rows.value.map((row) => ({
      kind: "task",
      key: row.task.ref,
      row,
      group: null,
    }))
  }

  const out: LayoutRow[] = []
  for (const section of groupTasks(
    rows.value,
    props.groups,
    (row) => row.task,
  )) {
    // An empty group would be a heading over nothing — on a chart that is just
    // a gap. The list is where an empty group needs to stay visible.
    if (!section.items.length) continue

    out.push({
      kind: "group",
      key: `group-${section.group?.ref ?? "none"}`,
      group: section.group,
      count: section.items.length,
      start: Math.min(...section.items.map((row) => row.start)),
      finish: Math.max(...section.items.map((row) => row.finish)),
    })
    for (const row of section.items) {
      out.push({ kind: "task", key: row.task.ref, row, group: section.group })
    }
  }
  return out
})

/** Row index by ref, over the laid-out rows rather than the schedule's own —
 *  the headings shift every bar below them down, links included. */
const rowIndex = computed(() => {
  const index = new Map<string, number>()
  layout.value.forEach((entry, at) => {
    if (entry.kind === "task") index.set(entry.row.task.ref.toLowerCase(), at)
  })
  return index
})

/* ------------------------------------------------------------------ geometry */

/** Everything is laid out from these three numbers, so the SVG links and the
 *  bars cannot drift apart: both are `unit * unitWidth` from the same origin. */
const unitWidth = ref(96)
const ROW_HEIGHT = 34
const LABEL_WIDTH = 300

const units = computed(() =>
  Array.from({ length: totalUnits.value }, (_, index) => index),
)
const canvasWidth = computed(
  () => LABEL_WIDTH + totalUnits.value * unitWidth.value,
)
const bodyHeight = computed(() => layout.value.length * ROW_HEIGHT)

const xOfUnit = (unit: number): number => LABEL_WIDTH + unit * unitWidth.value
const yOfRow = (index: number): number => index * ROW_HEIGHT + ROW_HEIGHT / 2

/**
 * One elbow per dependency: out of the blocker's right edge, across the gap,
 * and into the left edge of the task waiting on it. Only the blockers that
 * actually set the start are drawn — a link to something that finished long ago
 * would claim a task is held up by work it is not waiting for.
 */
const links = computed(() => {
  const index = rowIndex.value
  const drawn: { key: string; d: string; waiting: boolean }[] = []

  rows.value.forEach((row) => {
    const at = index.get(row.task.ref.toLowerCase())
    if (at === undefined) return

    for (const blockerRef of row.driverRefs) {
      const from = index.get(blockerRef.toLowerCase())
      if (from === undefined) continue

      const startX = xOfUnit(row.start)
      const fromY = yOfRow(from)
      const toY = yOfRow(at)
      // The elbow turns just before the bar it feeds, so links stacking into one
      // task stay distinguishable instead of overlapping along the whole run.
      const turn = startX - 10

      drawn.push({
        key: `${blockerRef}->${row.task.ref}`,
        d: `M ${startX - 18} ${fromY} H ${turn} V ${toY} H ${startX - 2}`,
        waiting: row.waiting,
      })
    }
  })

  return drawn
})

/* -------------------------------------------------------------- estimates */

/**
 * Change one estimate. Applied to the local task object first so the plan
 * re-lays out under the pointer — the reactive graph does the rest — and only
 * then written back. A failed write puts the old number back.
 */
async function setUnits(task: Task, units_: number): Promise<void> {
  const next = Math.min(MAX_ESTIMATE_UNITS, Math.max(1, units_))
  const previous = task.estimateUnits
  if (next === previous) return

  task.estimateUnits = next
  saving.value = task.ref
  error.value = null
  try {
    await api.updateTask(task.ref, { estimateUnits: next })
    emit("changed")
  } catch (caught) {
    task.estimateUnits = previous
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = null
  }
}

/* ------------------------------------------------------------ task summary */

/**
 * The task whose summary is showing. Clicking a bar opens this panel rather
 * than leaving for the list: reading the plan is a scanning job, and navigating
 * away loses the scroll position, the zoom and the filter every time.
 */
const openRef = ref<string | null>(null)

/** Resolved against the rows, not held as an object, so a task the filter now
 *  hides — or one that was deleted under us — closes the panel by itself. */
const openRow = computed(
  () => rows.value.find((row) => row.task.ref === openRef.value) ?? null,
)

const byRef = computed(() => {
  const index = new Map<string, Task>()
  for (const task of props.tasks) index.set(task.ref.toLowerCase(), task)
  return index
})

const titleOf = (ref_: string): string =>
  byRef.value.get(ref_.toLowerCase())?.title ?? "unknown task"

/** The group a task is in, resolved through the groups this view was handed —
 *  a ref pointing at a group that is gone reads as no group. */
const groupOfTask = (task: Task): TaskGroupSummary | null =>
  props.groups.find(
    (one) => one.ref.toLowerCase() === task.groupRef?.toLowerCase(),
  ) ?? null

/** Refs are only worth clicking when the plan has a row to jump to. */
const onPlan = (ref_: string): boolean =>
  rows.value.some((row) => row.task.ref.toLowerCase() === ref_.toLowerCase())

function selectTask(ref_: string): void {
  openRef.value =
    rows.value.find((row) => row.task.ref.toLowerCase() === ref_.toLowerCase())
      ?.task.ref ?? ref_
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && openRef.value) openRef.value = null
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onUnmounted(() => window.removeEventListener("keydown", onKeydown))

const formatDate = (value: string) => new Date(value).toLocaleString()

/* ----------------------------------------------------------------- summary */

const totalWork = computed(() =>
  rows.value.reduce((sum, row) => sum + row.duration, 0),
)

/** How much the dependencies cost: the plan is this many units long, but only
 *  `totalWork` units of it is work. */
const parallelism = computed(() =>
  rows.value.length ? (totalWork.value / totalUnits.value).toFixed(1) : "0",
)
</script>

<template>
  <section class="detail schedule">
    <header class="schedule-header">
      <div>
        <h2>Plan</h2>
        <p class="faint">
          Every task on a time axis of abstract units — one unit is one task's
          worth of work, not an hour. A task starts as soon as everything it
          depends on has finished.
        </p>
      </div>
    </header>

    <div class="schedule-toolbar">
      <label class="schedule-toggle">
        <input v-model="showClosed" type="checkbox" />
        Show closed
      </label>

      <label v-if="groups.length" class="schedule-toggle">
        <input v-model="showGroups" type="checkbox" />
        Bands
      </label>

      <select v-if="tags.length" v-model="tagFilter" aria-label="Filter by tag">
        <option value="">All tags</option>
        <option v-for="tag in tags" :key="tag" :value="tag">#{{ tag }}</option>
      </select>

      <select
        v-if="groups.length"
        v-model="groupFilter"
        aria-label="Filter by group"
      >
        <option value="">All groups</option>
        <option v-for="group in groups" :key="group.ref" :value="group.ref">
          {{ group.name }}
        </option>
        <option value="none">Ungrouped</option>
      </select>

      <label class="schedule-zoom">
        Zoom
        <input
          v-model.number="unitWidth"
          type="range"
          min="40"
          max="200"
          step="8"
          aria-label="Unit width"
        />
      </label>

      <span class="spacer" />

      <p class="faint schedule-summary">
        {{ rows.length }} task(s) · {{ totalWork }} unit(s) of work ·
        <strong>{{ totalUnits }}</strong> unit(s) long · {{ parallelism }} in
        parallel
      </p>
    </div>

    <p v-if="error" class="banner">{{ error }}</p>

    <p v-if="!rows.length" class="empty">
      Nothing to plan{{ tagFilter ? ` under #${tagFilter}` : ""
      }}{{ groupFilter ? " in that group" : "" }} yet.
    </p>

    <div v-else class="schedule-main">
      <div class="schedule-scroll">
        <div class="schedule-canvas" :style="{ width: `${canvasWidth}px` }">
          <!-- The axis. Units are numbered from one because "unit 0" reads as no
               time at all to anybody who did not write the scheduler. -->
          <div class="schedule-head" :style="{ height: `${ROW_HEIGHT}px` }">
            <div
              class="schedule-label schedule-head-label"
              :style="{ width: `${LABEL_WIDTH}px` }"
            >
              Task
            </div>
            <div
              v-for="unit in units"
              :key="unit"
              class="schedule-tick"
              :style="{ width: `${unitWidth}px` }"
            >
              {{ unit + 1 }}
            </div>
          </div>

          <div class="schedule-body" :style="{ height: `${bodyHeight}px` }">
            <!-- Column rules, drawn once behind everything rather than per row. -->
            <div
              v-for="unit in units"
              :key="`rule-${unit}`"
              class="schedule-rule"
              :style="{ left: `${xOfUnit(unit)}px` }"
            />

            <svg
              class="schedule-links"
              :width="canvasWidth"
              :height="bodyHeight"
              aria-hidden="true"
            >
              <path
                v-for="link in links"
                :key="link.key"
                :d="link.d"
                :class="{ waiting: link.waiting }"
              />
            </svg>

            <template v-for="(entry, index) in layout" :key="entry.key">
              <!-- A group's own row: the name on the left, and a summary bar
                   spanning from its earliest task to its latest, so the band
                   says where the group's work actually sits on the plan. -->
              <div
                v-if="entry.kind === 'group'"
                class="schedule-row schedule-band"
                :style="{
                  top: `${index * ROW_HEIGHT}px`,
                  height: `${ROW_HEIGHT}px`,
                  '--group-color': entry.group?.color ?? 'var(--text-faint)',
                }"
              >
                <div
                  class="schedule-label schedule-band-label"
                  :style="{ width: `${LABEL_WIDTH}px` }"
                >
                  <span class="group-dot" aria-hidden="true" />
                  <span class="schedule-band-name">{{
                    entry.group?.name ?? "Ungrouped"
                  }}</span>
                  <span class="faint">{{ entry.count }}</span>
                </div>
                <div
                  class="schedule-band-span"
                  :style="{
                    left: `${xOfUnit(entry.start)}px`,
                    width: `${(entry.finish - entry.start) * unitWidth - 6}px`,
                  }"
                  :title="`${entry.group?.name ?? 'Ungrouped'} — units ${entry.start + 1}–${entry.finish}`"
                />
              </div>

              <div
                v-else
                class="schedule-row"
                :class="{
                  selected: entry.row.task.ref === (openRef ?? selectedRef),
                  grouped: banded,
                }"
                :style="{
                  top: `${index * ROW_HEIGHT}px`,
                  height: `${ROW_HEIGHT}px`,
                  '--group-color': entry.group?.color ?? 'transparent',
                }"
              >
                <div
                  class="schedule-label"
                  :style="{ width: `${LABEL_WIDTH}px` }"
                >
                  <button
                    class="schedule-open"
                    :title="entry.row.task.title"
                    @click="selectTask(entry.row.task.ref)"
                  >
                    <span class="mono faint">{{ entry.row.task.ref }}</span>
                    <span class="schedule-title">{{
                      entry.row.task.title
                    }}</span>
                  </button>

                  <!-- The estimate lives here rather than in a dialog: changing
                       it is how you use this view, and the plan redraws as you
                       click. -->
                  <span
                    class="schedule-units"
                    :class="{ busy: saving === entry.row.task.ref }"
                  >
                    <button
                      :disabled="entry.row.duration <= 1"
                      aria-label="Shorter"
                      @click="setUnits(entry.row.task, entry.row.duration - 1)"
                    >
                      −
                    </button>
                    <span class="mono">{{ entry.row.duration }}</span>
                    <button
                      aria-label="Longer"
                      @click="setUnits(entry.row.task, entry.row.duration + 1)"
                    >
                      +
                    </button>
                  </span>
                </div>

                <button
                  class="schedule-bar"
                  :class="[
                    entry.row.task.status,
                    { waiting: entry.row.waiting },
                  ]"
                  :style="{
                    left: `${xOfUnit(entry.row.start)}px`,
                    width: `${entry.row.duration * unitWidth - 6}px`,
                  }"
                  :title="
                    `${entry.row.task.ref} — ${STATUS_LABELS[entry.row.task.status]}\nunits ${entry.row.start + 1}–${entry.row.finish} (${entry.row.duration})` +
                    (entry.group ? `\ngroup: ${entry.group.name}` : '') +
                    (entry.row.blockerRefs.length
                      ? `\nafter ${entry.row.blockerRefs.join(', ')}`
                      : '') +
                    (entry.row.ignoredRefs.length
                      ? `\nnot on this plan: ${entry.row.ignoredRefs.join(', ')}`
                      : '')
                  "
                  @click="selectTask(entry.row.task.ref)"
                >
                  <span class="schedule-bar-text">{{
                    entry.row.task.title
                  }}</span>
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- The summary. It reads the task rather than editing it, apart from the
           estimate the whole view is already about — anything more is a job for
           the list, one click away at the bottom. -->
      <aside v-if="openRow" class="schedule-panel" aria-label="Task summary">
        <div class="schedule-panel-head">
          <span class="mono dim">{{ openRow.task.ref }}</span>
          <span class="spacer" />
          <button
            class="schedule-panel-close"
            aria-label="Close summary"
            @click="openRef = null"
          >
            ✕
          </button>
        </div>

        <h3 class="schedule-panel-title">{{ openRow.task.title }}</h3>

        <div class="row" style="flex-wrap: wrap">
          <span class="badge" :class="openRow.task.status">{{
            STATUS_LABELS[openRow.task.status]
          }}</span>
          <span :class="`priority-${openRow.task.priority}`">{{
            openRow.task.priority
          }}</span>
          <span v-for="tag in openRow.task.tags" :key="tag" class="faint"
            >#{{ tag }}</span
          >
        </div>

        <!-- Where the plan puts it, in the same units the axis is drawn in. -->
        <dl class="schedule-panel-facts">
          <dt>On the plan</dt>
          <dd>
            unit{{ openRow.duration === 1 ? "" : "s" }}
            <strong>{{ openRow.start + 1 }}–{{ openRow.finish }}</strong>
            <span class="faint">
              ({{
                openRow.waiting
                  ? "waiting on unfinished work"
                  : "can start now"
              }})
            </span>
          </dd>

          <dt>Estimate</dt>
          <dd>
            <span
              class="schedule-units"
              :class="{ busy: saving === openRow.task.ref }"
            >
              <button
                :disabled="openRow.duration <= 1"
                aria-label="Shorter"
                @click="setUnits(openRow.task, openRow.duration - 1)"
              >
                −
              </button>
              <span class="mono">{{ openRow.duration }}</span>
              <button
                aria-label="Longer"
                @click="setUnits(openRow.task, openRow.duration + 1)"
              >
                +
              </button>
            </span>
            <span class="faint"
              >unit{{ openRow.duration === 1 ? "" : "s" }}</span
            >
          </dd>

          <dt>Group</dt>
          <dd>
            <span
              v-if="groupOfTask(openRow.task)"
              class="group-chip"
              :style="{ '--group-color': groupOfTask(openRow.task)!.color }"
            >
              {{ groupOfTask(openRow.task)!.name }}
            </span>
            <span v-else class="faint">none</span>
          </dd>

          <dt>Branch</dt>
          <dd class="mono faint">{{ openRow.task.branchName ?? "none" }}</dd>

          <dt>Updated</dt>
          <dd class="faint">{{ formatDate(openRow.task.updatedAt) }}</dd>
        </dl>

        <!-- Both directions of the dependency, because the question a bar raises
             is as often "what is this holding up" as "what is holding it up". -->
        <div
          v-if="openRow.task.dependsOn.length"
          class="schedule-panel-section"
        >
          <h4>Waits for</h4>
          <ul class="schedule-panel-refs">
            <li v-for="ref_ in openRow.task.dependsOn" :key="ref_">
              <button :disabled="!onPlan(ref_)" @click="selectTask(ref_)">
                <span class="mono">{{ ref_ }}</span>
                <span class="schedule-panel-ref-title">{{
                  titleOf(ref_)
                }}</span>
              </button>
              <span v-if="!onPlan(ref_)" class="faint">not on this plan</span>
            </li>
          </ul>
        </div>

        <div v-if="openRow.task.blocks.length" class="schedule-panel-section">
          <h4>Blocks</h4>
          <ul class="schedule-panel-refs">
            <li v-for="ref_ in openRow.task.blocks" :key="ref_">
              <button :disabled="!onPlan(ref_)" @click="selectTask(ref_)">
                <span class="mono">{{ ref_ }}</span>
                <span class="schedule-panel-ref-title">{{
                  titleOf(ref_)
                }}</span>
              </button>
              <span v-if="!onPlan(ref_)" class="faint">not on this plan</span>
            </li>
          </ul>
        </div>

        <div v-if="openRow.task.description" class="schedule-panel-section">
          <h4>Description</h4>
          <MarkdownBlock :source="openRow.task.description" />
        </div>

        <!-- Everything the summary leaves out — editing, status, the agent —
             lives in the list, so the way there stays one click. -->
        <div class="schedule-panel-foot">
          <button class="primary" @click="emit('open-task', openRow.task.ref)">
            Open in task list →
          </button>
        </div>
      </aside>
    </div>

    <p v-if="rows.length" class="faint schedule-legend">
      <span class="schedule-swatch backlog" /> Backlog
      <span class="schedule-swatch in_progress" /> In progress
      <span class="schedule-swatch dev_complete" /> Dev complete
      <span class="schedule-swatch verified" /> Verified
      <span class="schedule-swatch closed" /> Closed
      <template v-if="banded">
        · Bands are groups; a group's bar spans its earliest task to its latest.
      </template>
      · A dashed link means the blocker is not finished yet. Dependencies
      pointing at tasks this filter hides are ignored, not assumed.
    </p>
  </section>
</template>
