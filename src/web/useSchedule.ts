import { computed, type ComputedRef, type Ref } from 'vue';
import { DEFAULT_ESTIMATE_UNITS, satisfiesDependency, type Task } from '@shared/types';

/**
 * Where a task sits on the plan.
 *
 * The axis is units, not time: unit 0 is "as soon as anything can start", and a
 * task that waits on nothing begins there no matter what its dates say. Every
 * dependency is finish-to-start with no lag, so a task's start is simply the
 * latest finish among its blockers.
 */
export interface ScheduledTask {
  task: Task;
  /** First unit the task occupies, 0-based. */
  start: number;
  /** Units it occupies — its estimate. */
  duration: number;
  /** First unit *after* the task, i.e. `start + duration`. */
  finish: number;
  /** Blockers that actually decide the start — those finishing exactly when this
   *  one begins. Everything else has slack, so drawing all of them would say a
   *  task is held up by things it is not waiting on. */
  driverRefs: string[];
  /** Blockers inside the plan, in list order — what the links are drawn from. */
  blockerRefs: string[];
  /** Blockers the plan cannot see, because the filter hides them or they are
   *  gone. Skipped rather than assumed to block, matching `unmetDependencies`. */
  ignoredRefs: string[];
  /** Whether the task still has unfinished work in front of it. */
  waiting: boolean;
}

interface Node {
  task: Task;
  blockers: string[];
  start: ComputedRef<number>;
  finish: ComputedRef<number>;
}

/** An estimate that is missing or nonsense still has to render as something. */
function durationOf(task: Task): number {
  const units = task.estimateUnits ?? DEFAULT_ESTIMATE_UNITS;
  return Number.isFinite(units) && units >= 1 ? Math.floor(units) : DEFAULT_ESTIMATE_UNITS;
}

/**
 * Refs are compared case-insensitively throughout — `dependsOn` holds whatever
 * was typed, and `T-4` and `t-4` are the same task everywhere else in this app.
 */
const keyOf = (ref: string): string => ref.toLowerCase();

/**
 * Build the dependency graph as a web of computeds — one `start` and one
 * `finish` per task, each reading its blockers' `finish`.
 *
 * This is the whole scheduling engine: nothing walks the graph, and nothing is
 * recomputed on a timer. Vue tracks which task read which, so changing one
 * estimate invalidates exactly the tasks downstream of it and leaves the rest of
 * the plan cached. The getters are lazy, so referring to `graph` before it is
 * fully populated is safe — nothing evaluates until something reads it.
 */
function buildGraph(tasks: Task[]): Map<string, Node> {
  const graph = new Map<string, Node>();
  const known = new Set(tasks.map((task) => keyOf(task.ref)));

  // Which tasks are part-way through being scheduled, so a cycle can be broken
  // at the edge that closes it. The server refuses to create one, so this only
  // ever fires on an inconsistent snapshot — but without it a cycle is infinite
  // recursion through the getters, and Vue answers a computed that re-enters
  // itself with `undefined`, which spreads NaN across the whole plan.
  const evaluating = new Set<string>();

  for (const task of tasks) {
    const key = keyOf(task.ref);
    const blockers = [
      ...new Set(task.dependsOn.map(keyOf).filter((ref) => ref !== key && known.has(ref))),
    ];

    const start = computed(() => {
      evaluating.add(key);
      try {
        let latest = 0;
        for (const blocker of blockers) {
          // Reading a blocker that is itself waiting on this task would close
          // the loop; the edge is dropped rather than followed.
          if (evaluating.has(blocker)) continue;
          const upstream = graph.get(blocker);
          if (upstream) latest = Math.max(latest, upstream.finish.value);
        }
        return latest;
      } finally {
        evaluating.delete(key);
      }
    });

    graph.set(key, {
      task,
      blockers,
      start,
      finish: computed(() => start.value + durationOf(task)),
    });
  }

  return graph;
}

/**
 * The plan for a set of tasks.
 *
 * Pass the tasks the plan should contain — filtering happens outside, because
 * "which tasks are on the plan" is a view decision and dependencies pointing
 * outside the set are deliberately ignored rather than guessed at.
 */
export function useSchedule(source: Ref<Task[]> | ComputedRef<Task[]>) {
  // Rebuilt only when the shape of the plan changes. The getters read each
  // task's estimate rather than closing over it, so retyping an estimate flows
  // through the existing graph instead of replacing it.
  const graph = computed(() => buildGraph(source.value));

  const rows = computed<ScheduledTask[]>(() => {
    const nodes = graph.value;
    const scheduled: ScheduledTask[] = [];

    for (const node of nodes.values()) {
      const start = node.start.value;
      const inPlan = new Set(node.blockers);

      scheduled.push({
        task: node.task,
        start,
        duration: durationOf(node.task),
        finish: node.finish.value,
        blockerRefs: node.blockers.map((ref) => nodes.get(ref)!.task.ref),
        driverRefs: node.blockers
          .filter((ref) => nodes.get(ref)!.finish.value === start && start > 0)
          .map((ref) => nodes.get(ref)!.task.ref),
        ignoredRefs: node.task.dependsOn.filter((ref) => !inPlan.has(keyOf(ref))),
        waiting: node.blockers.some((ref) => !satisfiesDependency(nodes.get(ref)!.task.status)),
      });
    }

    // Earliest first, then the user's own queue order — so two tasks that can
    // both start now appear in the order the list says to do them in.
    return scheduled.sort(
      (left, right) => left.start - right.start || left.task.position - right.task.position,
    );
  });

  /** How wide the plan is. At least one, so an empty plan still draws an axis. */
  const totalUnits = computed(() =>
    Math.max(1, ...rows.value.map((row) => row.finish)),
  );

  /** Row index by ref, for drawing a link between two bars. */
  const rowIndex = computed(() => {
    const index = new Map<string, number>();
    rows.value.forEach((row, at) => index.set(keyOf(row.task.ref), at));
    return index;
  });

  return { rows, totalUnits, rowIndex };
}
