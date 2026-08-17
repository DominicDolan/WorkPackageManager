<script setup lang="ts">
import { computed, ref } from 'vue';
import { MAX_ESTIMATE_UNITS, STATUS_LABELS, type Task } from '@shared/types';
import { api } from '../api';
import { useSchedule } from '../useSchedule';

const props = defineProps<{
  tasks: Task[];
  /** Highlighted row — the task selected over in the list view. */
  selectedRef: string | null;
}>();

const emit = defineEmits<{
  (event: 'open-task', ref: string): void;
  /** An estimate was saved; the list this view was handed is now stale. */
  (event: 'changed'): void;
}>();

const error = ref<string | null>(null);
const saving = ref<string | null>(null);

/* ------------------------------------------------------------- what is on it */

/** Closed work is history, not plan — but it is one click away, because a chain
 *  reads oddly when the thing everything hangs off has vanished. */
const showClosed = ref(false);
const tagFilter = ref('');

const tags = computed(() =>
  [...new Set(props.tasks.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b)),
);

const planned = computed(() =>
  props.tasks.filter(
    (task) =>
      (showClosed.value || task.status !== 'closed') &&
      (!tagFilter.value || task.tags.includes(tagFilter.value)),
  ),
);

const { rows, totalUnits, rowIndex } = useSchedule(planned);

/* ------------------------------------------------------------------ geometry */

/** Everything is laid out from these three numbers, so the SVG links and the
 *  bars cannot drift apart: both are `unit * unitWidth` from the same origin. */
const unitWidth = ref(96);
const ROW_HEIGHT = 34;
const LABEL_WIDTH = 300;

const units = computed(() => Array.from({ length: totalUnits.value }, (_, index) => index));
const canvasWidth = computed(() => LABEL_WIDTH + totalUnits.value * unitWidth.value);
const bodyHeight = computed(() => rows.value.length * ROW_HEIGHT);

const xOfUnit = (unit: number): number => LABEL_WIDTH + unit * unitWidth.value;
const yOfRow = (index: number): number => index * ROW_HEIGHT + ROW_HEIGHT / 2;

/**
 * One elbow per dependency: out of the blocker's right edge, across the gap,
 * and into the left edge of the task waiting on it. Only the blockers that
 * actually set the start are drawn — a link to something that finished long ago
 * would claim a task is held up by work it is not waiting for.
 */
const links = computed(() => {
  const index = rowIndex.value;
  const drawn: { key: string; d: string; waiting: boolean }[] = [];

  rows.value.forEach((row, at) => {
    for (const blockerRef of row.driverRefs) {
      const from = index.get(blockerRef.toLowerCase());
      if (from === undefined) continue;

      const startX = xOfUnit(row.start);
      const fromY = yOfRow(from);
      const toY = yOfRow(at);
      // The elbow turns just before the bar it feeds, so links stacking into one
      // task stay distinguishable instead of overlapping along the whole run.
      const turn = startX - 10;

      drawn.push({
        key: `${blockerRef}->${row.task.ref}`,
        d: `M ${startX - 18} ${fromY} H ${turn} V ${toY} H ${startX - 2}`,
        waiting: row.waiting,
      });
    }
  });

  return drawn;
});

/* -------------------------------------------------------------- estimates */

/**
 * Change one estimate. Applied to the local task object first so the plan
 * re-lays out under the pointer — the reactive graph does the rest — and only
 * then written back. A failed write puts the old number back.
 */
async function setUnits(task: Task, units_: number): Promise<void> {
  const next = Math.min(MAX_ESTIMATE_UNITS, Math.max(1, units_));
  const previous = task.estimateUnits;
  if (next === previous) return;

  task.estimateUnits = next;
  saving.value = task.ref;
  error.value = null;
  try {
    await api.updateTask(task.ref, { estimateUnits: next });
    emit('changed');
  } catch (caught) {
    task.estimateUnits = previous;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    saving.value = null;
  }
}

/* ----------------------------------------------------------------- summary */

const totalWork = computed(() =>
  rows.value.reduce((sum, row) => sum + row.duration, 0),
);

/** How much the dependencies cost: the plan is this many units long, but only
 *  `totalWork` units of it is work. */
const parallelism = computed(() =>
  rows.value.length ? (totalWork.value / totalUnits.value).toFixed(1) : '0',
);
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

      <select v-if="tags.length" v-model="tagFilter" aria-label="Filter by tag">
        <option value="">All tags</option>
        <option v-for="tag in tags" :key="tag" :value="tag">#{{ tag }}</option>
      </select>

      <label class="schedule-zoom">
        Zoom
        <input v-model.number="unitWidth" type="range" min="40" max="200" step="8" aria-label="Unit width" />
      </label>

      <span class="spacer" />

      <p class="faint schedule-summary">
        {{ rows.length }} task(s) · {{ totalWork }} unit(s) of work ·
        <strong>{{ totalUnits }}</strong> unit(s) long · {{ parallelism }} in parallel
      </p>
    </div>

    <p v-if="error" class="banner">{{ error }}</p>

    <p v-if="!rows.length" class="empty">
      Nothing to plan{{ tagFilter ? ` under #${tagFilter}` : '' }} yet.
    </p>

    <div v-else class="schedule-scroll">
      <div class="schedule-canvas" :style="{ width: `${canvasWidth}px` }">
        <!-- The axis. Units are numbered from one because "unit 0" reads as no
             time at all to anybody who did not write the scheduler. -->
        <div class="schedule-head" :style="{ height: `${ROW_HEIGHT}px` }">
          <div class="schedule-label schedule-head-label" :style="{ width: `${LABEL_WIDTH}px` }">
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

          <div
            v-for="(row, index) in rows"
            :key="row.task.ref"
            class="schedule-row"
            :class="{ selected: selectedRef === row.task.ref }"
            :style="{ top: `${index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }"
          >
            <div class="schedule-label" :style="{ width: `${LABEL_WIDTH}px` }">
              <button class="schedule-open" :title="row.task.title" @click="emit('open-task', row.task.ref)">
                <span class="mono faint">{{ row.task.ref }}</span>
                <span class="schedule-title">{{ row.task.title }}</span>
              </button>

              <!-- The estimate lives here rather than in a dialog: changing it
                   is how you use this view, and the plan redraws as you click. -->
              <span class="schedule-units" :class="{ busy: saving === row.task.ref }">
                <button
                  :disabled="row.duration <= 1"
                  aria-label="Shorter"
                  @click="setUnits(row.task, row.duration - 1)"
                >
                  −
                </button>
                <span class="mono">{{ row.duration }}</span>
                <button aria-label="Longer" @click="setUnits(row.task, row.duration + 1)">+</button>
              </span>
            </div>

            <button
              class="schedule-bar"
              :class="[row.task.status, { waiting: row.waiting }]"
              :style="{ left: `${xOfUnit(row.start)}px`, width: `${row.duration * unitWidth - 6}px` }"
              :title="`${row.task.ref} — ${STATUS_LABELS[row.task.status]}\nunits ${row.start + 1}–${row.finish} (${row.duration})` +
                (row.blockerRefs.length ? `\nafter ${row.blockerRefs.join(', ')}` : '') +
                (row.ignoredRefs.length ? `\nnot on this plan: ${row.ignoredRefs.join(', ')}` : '')"
              @click="emit('open-task', row.task.ref)"
            >
              <span class="schedule-bar-text">{{ row.task.title }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <p v-if="rows.length" class="faint schedule-legend">
      <span class="schedule-swatch backlog" /> Backlog
      <span class="schedule-swatch in_progress" /> In progress
      <span class="schedule-swatch dev_complete" /> Dev complete
      <span class="schedule-swatch verified" /> Verified
      <span class="schedule-swatch closed" /> Closed
      · A dashed link means the blocker is not finished yet.
      Dependencies pointing at tasks this filter hides are ignored, not assumed.
    </p>
  </section>
</template>
