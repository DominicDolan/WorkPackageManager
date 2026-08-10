import { getDb, nextRef, nowIso } from './db';
import { workspace } from '../config/paths';
import {
  branchNameFor,
  checkpointNameFor,
  PRIORITIES,
  STATUSES,
  type CheckpointRun,
  type CombinedBranch,
  type Comparison,
  type Phase,
  type Priority,
  type Status,
  type Task,
  type TaskDetail,
  type TaskEvent,
} from '../shared/types';

/* ------------------------------------------------------------------ rows */

interface TaskRow {
  id: number;
  ref: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  tags: string;
  branch_name: string | null;
  checkpoint_name: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  dev_completed_at: string | null;
  verified_at: string | null;
  closed_at: string | null;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    status: row.status as Status,
    priority: row.priority as Priority,
    tags: JSON.parse(row.tags) as string[],
    branchName: row.branch_name,
    checkpointName: row.checkpoint_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    devCompletedAt: row.dev_completed_at,
    verifiedAt: row.verified_at,
    closedAt: row.closed_at,
  };
}

/* ------------------------------------------------------------- validation */

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/** Conservative Git branch validation, shared by CLI and HTTP callers. */
export function validateBranchName(value: string): string {
  const branch = value.trim();
  if (!branch || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') ||
      branch.includes('//') || branch.includes('..') || branch.includes('@{') ||
      /[\s~^:?*\\[\\]/.test(branch) || branch.split('/').some((part) => part === '.' || part.endsWith('.lock'))) {
    throw new Error(`Invalid Git branch name '${value}'.`);
  }
  return branch;
}

/** Timestamp column that a given status stamps on entry. */
const STATUS_TIMESTAMP: Partial<Record<Status, string>> = {
  in_progress: 'started_at',
  dev_complete: 'dev_completed_at',
  verified: 'verified_at',
  closed: 'closed_at',
};

/* -------------------------------------------------------------- queries */

export function listTasks(filter?: { status?: Status; tag?: string }): Task[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (filter?.status) {
    clauses.push('status = $status');
    params.$status = filter.status;
  } else {
    // Closed tasks remain auditable by explicit status query but no longer
    // clutter the normal task list.
    clauses.push("status != 'closed'");
  }
  if (filter?.tag) {
    // tags is a JSON array; match the quoted element to avoid substring hits.
    clauses.push('tags LIKE $tag');
    params.$tag = `%"${filter.tag}"%`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .query<TaskRow, typeof params>(
      `SELECT * FROM tasks ${where}
       ORDER BY CASE status
                  WHEN 'in_progress'  THEN 0
                  WHEN 'dev_complete' THEN 1
                  WHEN 'backlog'      THEN 2
                  WHEN 'verified'     THEN 3
                  ELSE 4
                END,
                CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                id DESC`,
    )
    .all(params);

  return rows.map(toTask);
}

export function findTask(ref: string): Task | null {
  const row = getDb()
    .query<TaskRow, { $ref: string }>('SELECT * FROM tasks WHERE ref = $ref COLLATE NOCASE')
    .get({ $ref: ref });
  return row ? toTask(row) : null;
}

/** Same as findTask but throws the message the CLI and API both want to show. */
export function requireTask(ref: string): Task {
  const task = findTask(ref);
  if (!task) throw new Error(`No task with ref '${ref}'.`);
  return task;
}

export function listEvents(taskId: number): TaskEvent[] {
  return getDb()
    .query<
      {
        id: number;
        task_id: number;
        type: string;
        from_status: string | null;
        to_status: string | null;
        note: string | null;
        created_at: string;
      },
      { $id: number }
    >('SELECT * FROM task_events WHERE task_id = $id ORDER BY id ASC')
    .all({ $id: taskId })
    .map((row) => ({
      id: row.id,
      taskId: row.task_id,
      type: row.type as TaskEvent['type'],
      fromStatus: row.from_status as Status | null,
      toStatus: row.to_status as Status | null,
      note: row.note,
      createdAt: row.created_at,
    }));
}

export function listRuns(taskId: number): CheckpointRun[] {
  const db = getDb();

  const runRows = db
    .query<
      {
        id: number;
        task_id: number;
        checkpoint_name: string;
        phase: string;
        exit_code: number;
        git_head: string | null;
        git_dirty: number | null;
        scenario_count: number;
        selection_json: string | null;
        created_at: string;
      },
      { $id: number }
    >('SELECT * FROM checkpoint_runs WHERE task_id = $id ORDER BY id ASC')
    .all({ $id: taskId });

  const comparisonRows = db
    .query<
      {
        id: number;
        run_id: number;
        scenario: string;
        description: string | null;
        status: string;
        percent_changed: number | null;
        pixel_diff_count: number | null;
        total_pixels: number | null;
        before_path: string | null;
        after_path: string | null;
        diff_path: string | null;
        browser_log_status: string | null;
        browser_log_change_count: number | null;
      },
      { $id: number }
    >(
      `SELECT c.* FROM checkpoint_comparisons c
       JOIN checkpoint_runs r ON r.id = c.run_id
       WHERE r.task_id = $id
       ORDER BY c.id ASC`,
    )
    .all({ $id: taskId });

  const byRun = new Map<number, Comparison[]>();
  for (const row of comparisonRows) {
    const comparison: Comparison = {
      id: row.id,
      runId: row.run_id,
      scenario: row.scenario,
      description: row.description,
      status: row.status as Comparison['status'],
      percentChanged: row.percent_changed,
      pixelDiffCount: row.pixel_diff_count,
      totalPixels: row.total_pixels,
      beforePath: row.before_path,
      afterPath: row.after_path,
      diffPath: row.diff_path,
      browserLogStatus: row.browser_log_status,
      browserLogChangeCount: row.browser_log_change_count,
    };
    const bucket = byRun.get(row.run_id);
    if (bucket) bucket.push(comparison);
    else byRun.set(row.run_id, [comparison]);
  }

  return runRows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    checkpointName: row.checkpoint_name,
    phase: row.phase as Phase,
    exitCode: row.exit_code,
    gitHead: row.git_head,
    gitDirty: row.git_dirty,
    scenarioCount: row.scenario_count,
    selection: row.selection_json ? JSON.parse(row.selection_json) : null,
    createdAt: row.created_at,
    comparisons: byRun.get(row.id) ?? [],
  }));
}

export function getTaskDetail(ref: string): TaskDetail {
  const task = requireTask(ref);
  return { ...task, events: listEvents(task.id), runs: listRuns(task.id) };
}

/* -------------------------------------------------------------- mutations */

function addEvent(
  taskId: number,
  type: TaskEvent['type'],
  fields: { fromStatus?: Status | null; toStatus?: Status | null; note?: string | null } = {},
): void {
  getDb()
    .query(
      `INSERT INTO task_events (task_id, type, from_status, to_status, note, created_at)
       VALUES ($task, $type, $from, $to, $note, $at)`,
    )
    .run({
      $task: taskId,
      $type: type,
      $from: fields.fromStatus ?? null,
      $to: fields.toStatus ?? null,
      $note: fields.note ?? null,
      $at: nowIso(),
    });
}

export interface CreateInput {
  title: string;
  description?: string;
  priority?: Priority;
  tags?: string[];
  branchName?: string;
}

export function createTask(input: CreateInput): Task {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title.');

  const at = nowIso();
  const ref = nextRef();
  const branchName = input.branchName === undefined
    ? branchNameFor(ref, title, workspace().config.branchPrefix)
    : validateBranchName(input.branchName);

  getDb()
    .query(
      `INSERT INTO tasks (ref, title, description, status, priority, tags, branch_name,
                          checkpoint_name, created_at, updated_at)
       VALUES ($ref, $title, $description, 'backlog', $priority, $tags, $branch,
               $checkpoint, $at, $at)`,
    )
    .run({
      $ref: ref,
      $title: title,
      $description: input.description?.trim() ?? '',
      $priority: input.priority ?? 'medium',
      $tags: JSON.stringify(input.tags ?? []),
      $branch: branchName,
      $checkpoint: checkpointNameFor(ref, workspace().config.checkpointPrefix),
      $at: at,
    });

  const task = requireTask(ref);
  addEvent(task.id, 'created', { toStatus: 'backlog', note: title });
  return task;
}

export interface UpdateInput {
  title?: string;
  description?: string;
  priority?: Priority;
  tags?: string[];
}

export function updateTask(ref: string, input: UpdateInput): Task {
  const task = requireTask(ref);

  const assignments: string[] = [];
  const params: Record<string, string | number> = { $ref: task.ref, $at: nowIso() };
  const changed: string[] = [];

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error('A task needs a title.');
    assignments.push('title = $title');
    params.$title = title;
    changed.push('title');
  }
  if (input.description !== undefined) {
    assignments.push('description = $description');
    params.$description = input.description;
    changed.push('description');
  }
  if (input.priority !== undefined) {
    assignments.push('priority = $priority');
    params.$priority = input.priority;
    changed.push('priority');
  }
  if (input.tags !== undefined) {
    assignments.push('tags = $tags');
    params.$tags = JSON.stringify(input.tags);
    changed.push('tags');
  }

  if (!assignments.length) return task;

  getDb()
    .query(`UPDATE tasks SET ${assignments.join(', ')}, updated_at = $at WHERE ref = $ref`)
    .run(params);

  addEvent(task.id, 'edited', { note: `changed ${changed.join(', ')}` });
  return requireTask(task.ref);
}

export function setStatus(ref: string, status: Status, note?: string): Task {
  const task = requireTask(ref);
  if (task.status === status) return task;

  const at = nowIso();
  const stamp = STATUS_TIMESTAMP[status];
  // Re-entering a state refreshes its timestamp, so a reopened task reports
  // when it most recently reached dev_complete rather than the first time.
  const stampClause = stamp ? `, ${stamp} = $at` : '';

  getDb()
    .query(`UPDATE tasks SET status = $status, updated_at = $at${stampClause} WHERE ref = $ref`)
    .run({ $status: status, $at: at, $ref: task.ref });

  addEvent(task.id, 'status', { fromStatus: task.status, toStatus: status, note: note ?? null });
  return requireTask(task.ref);
}

export function addNote(ref: string, note: string): Task {
  const task = requireTask(ref);
  const text = note.trim();
  if (!text) throw new Error('An empty note is not worth recording.');

  addEvent(task.id, 'note', { note: text });
  getDb()
    .query('UPDATE tasks SET updated_at = $at WHERE ref = $ref')
    .run({ $at: nowIso(), $ref: task.ref });

  return requireTask(task.ref);
}

export function deleteTask(ref: string): void {
  const task = requireTask(ref);
  getDb().query('DELETE FROM tasks WHERE id = $id').run({ $id: task.id });
}

/** Record that a task's work was included in a combined delivery branch. */
export function recordCombinedBranch(ref: string, branchName: string): void {
  addNote(ref, `Included in combined branch '${branchName}'.`);
}

/* ----------------------------------------------------- combined branches */

interface CombinedBranchRow {
  id: number;
  branch_name: string;
  base_branch: string | null;
  task_refs: string;
  pr_title: string | null;
  pr_body: string | null;
  pr_url: string | null;
  pr_number: number | null;
  created_at: string;
  updated_at: string;
}

function toCombinedBranch(row: CombinedBranchRow): CombinedBranch {
  let taskRefs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.task_refs);
    if (Array.isArray(parsed)) taskRefs = parsed.map(String);
  } catch {
    // A hand-edited row should not take the whole list down with it.
  }

  return {
    id: row.id,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    taskRefs,
    prTitle: row.pr_title,
    prBody: row.pr_body,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCombinedBranches(): CombinedBranch[] {
  return getDb()
    .query<CombinedBranchRow, []>('SELECT * FROM combined_branches ORDER BY id DESC')
    .all()
    .map(toCombinedBranch);
}

export function findCombinedBranch(branchName: string): CombinedBranch | null {
  const row = getDb()
    .query<CombinedBranchRow, { $name: string }>(
      'SELECT * FROM combined_branches WHERE branch_name = $name',
    )
    .get({ $name: branchName });

  return row ? toCombinedBranch(row) : null;
}

export function requireCombinedBranch(branchName: string): CombinedBranch {
  const branch = findCombinedBranch(branchName);
  if (!branch) throw new Error(`No combined branch named '${branchName}'.`);
  return branch;
}

/** Called once a combine's Git work has fully succeeded. */
export function recordCombine(input: {
  branchName: string;
  baseBranch: string | null;
  taskRefs: string[];
}): CombinedBranch {
  const at = nowIso();
  getDb()
    .query(
      `INSERT INTO combined_branches (branch_name, base_branch, task_refs, created_at, updated_at)
       VALUES ($name, $base, $refs, $at, $at)
       ON CONFLICT(branch_name) DO UPDATE
         SET base_branch = $base, task_refs = $refs, updated_at = $at`,
    )
    .run({
      $name: input.branchName,
      $base: input.baseBranch,
      $refs: JSON.stringify(input.taskRefs),
      $at: at,
    });

  return requireCombinedBranch(input.branchName);
}

/** Partial update. Only the keys present are written, so saving a description
 *  never clears a PR url recorded by a different request. */
export function updateCombinedBranch(
  branchName: string,
  input: {
    baseBranch?: string | null;
    prTitle?: string | null;
    prBody?: string | null;
    prUrl?: string | null;
    prNumber?: number | null;
  },
): CombinedBranch {
  requireCombinedBranch(branchName);

  const columns = {
    baseBranch: 'base_branch',
    prTitle: 'pr_title',
    prBody: 'pr_body',
    prUrl: 'pr_url',
    prNumber: 'pr_number',
  } as const;

  const assignments: string[] = [];
  const params: Record<string, string | number | null> = {
    $name: branchName,
    $at: nowIso(),
  };

  for (const [key, column] of Object.entries(columns)) {
    const value = input[key as keyof typeof input];
    if (value === undefined) continue;
    assignments.push(`${column} = $${key}`);
    params[`$${key}`] = value;
  }

  if (assignments.length) {
    getDb()
      .query(
        `UPDATE combined_branches SET ${assignments.join(', ')}, updated_at = $at
          WHERE branch_name = $name`,
      )
      .run(params);
  }

  return requireCombinedBranch(branchName);
}

export function deleteCombinedBranch(branchName: string): void {
  requireCombinedBranch(branchName);
  getDb()
    .query('DELETE FROM combined_branches WHERE branch_name = $name')
    .run({ $name: branchName });
}

/* ----------------------------------------------------- checkpoint records */

export interface RecordRunInput {
  taskId: number;
  checkpointName: string;
  phase: Phase;
  exitCode: number;
  gitHead: string | null;
  gitDirty: boolean | null;
  scenarioCount: number;
  selection: { scenarios?: string[]; folders?: string[] } | null;
  raw: unknown;
  comparisons: Omit<Comparison, 'id' | 'runId'>[];
}

export function recordRun(input: RecordRunInput): number {
  const db = getDb();

  const insert = db.transaction((run: RecordRunInput) => {
    const row = db
      .query<{ id: number }, Record<string, string | number | null>>(
        `INSERT INTO checkpoint_runs (task_id, checkpoint_name, phase, exit_code,
                                      git_head, git_dirty, scenario_count, raw_json,
                                      selection_json, created_at)
         VALUES ($task, $name, $phase, $exit, $head, $dirty, $count, $raw, $selection, $at)
         RETURNING id`,
      )
      .get({
        $task: run.taskId,
        $name: run.checkpointName,
        $phase: run.phase,
        $exit: run.exitCode,
        $head: run.gitHead,
        $dirty: run.gitDirty === null ? null : run.gitDirty ? 1 : 0,
        $count: run.scenarioCount,
        $raw: run.raw === undefined ? null : JSON.stringify(run.raw),
        $selection: run.selection ? JSON.stringify(run.selection) : null,
        $at: nowIso(),
      });

    const runId = row!.id;
    const statement = db.query(
      `INSERT INTO checkpoint_comparisons (run_id, scenario, description, status,
              percent_changed, pixel_diff_count, total_pixels,
              before_path, after_path, diff_path,
              browser_log_status, browser_log_change_count)
       VALUES ($run, $scenario, $description, $status,
               $percent, $pixels, $total,
               $before, $after, $diff,
               $logStatus, $logCount)`,
    );

    for (const comparison of run.comparisons) {
      statement.run({
        $run: runId,
        $scenario: comparison.scenario,
        $description: comparison.description,
        $status: comparison.status,
        $percent: comparison.percentChanged,
        $pixels: comparison.pixelDiffCount,
        $total: comparison.totalPixels,
        $before: comparison.beforePath,
        $after: comparison.afterPath,
        $diff: comparison.diffPath,
        $logStatus: comparison.browserLogStatus,
        $logCount: comparison.browserLogChangeCount,
      });
    }

    return runId;
  });

  const runId = insert(input);
  addEvent(input.taskId, 'checkpoint', {
    note: `${input.phase} checkpoint '${input.checkpointName}' — ${input.scenarioCount} scenario(s)`,
  });
  return runId;
}

/** Most recent run of a phase, used to tell whether `before` was ever captured. */
export function latestRun(taskId: number, phase: Phase): CheckpointRun | null {
  const runs = listRuns(taskId).filter((run) => run.phase === phase);
  return runs.length ? runs[runs.length - 1]! : null;
}
