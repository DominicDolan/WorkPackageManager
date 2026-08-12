import { getDb, nextInvestigationRef, nextRef, nowIso } from './db';
import { workspace } from '../config/paths';
import {
  branchNameFor,
  checkpointNameFor,
  INVESTIGATION_STATUSES,
  PRIORITIES,
  STATUSES,
  type CheckpointRun,
  type CombinedBranch,
  type Comparison,
  type Investigation,
  type InvestigationDetail,
  type InvestigationStatus,
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
  position: number;
  tags: string;
  investigation_ref: string | null;
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
    position: row.position,
    tags: JSON.parse(row.tags) as string[],
    investigationRef: row.investigation_ref,
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

export function isInvestigationStatus(value: string): value is InvestigationStatus {
  return (INVESTIGATION_STATUSES as readonly string[]).includes(value);
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

export function listTasks(filter?: {
  status?: Status;
  tag?: string;
  investigationRef?: string;
  /** Keep closed tasks in the result. An investigation's own list uses this: a
   *  task it filed and saw through to closed is the outcome, not clutter. */
  includeClosed?: boolean;
}): Task[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (filter?.investigationRef) {
    clauses.push('investigation_ref = $investigation COLLATE NOCASE');
    params.$investigation = filter.investigationRef;
  }
  if (filter?.status) {
    clauses.push('status = $status');
    params.$status = filter.status;
  } else if (!filter?.includeClosed) {
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
      // Manual order is the only order. Status and priority used to sort the
      // list; they now only describe a task, because the list is a queue the
      // user arranges and `/work-task` takes from the top of.
      `SELECT * FROM tasks ${where} ORDER BY position ASC, id DESC`,
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
  /** The investigation this task came out of, if any. Validated here so a typo'd
   *  ref fails loudly rather than producing a task nothing links to. */
  investigationRef?: string;
}

export function createTask(input: CreateInput): Task {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title.');

  // Resolved before the ref counter is bumped, so a typo'd investigation does
  // not silently burn a task number.
  const investigation = input.investigationRef
    ? requireInvestigation(input.investigationRef).ref
    : null;

  const at = nowIso();
  const ref = nextRef();
  const branchName = input.branchName === undefined
    ? branchNameFor(ref, title, workspace().config.branchPrefix)
    : validateBranchName(input.branchName);

  getDb()
    .query(
      `INSERT INTO tasks (ref, title, description, status, priority, position, tags, branch_name,
                          investigation_ref, checkpoint_name, created_at, updated_at)
       VALUES ($ref, $title, $description, 'backlog', $priority, $position, $tags, $branch,
               $investigation, $checkpoint, $at, $at)`,
    )
    .run({
      $ref: ref,
      $title: title,
      // Appended, never promoted: the list is a queue the user arranges, and a
      // task filed mid-session must not silently become the next one worked.
      // Batch filing (an investigation's tasks) therefore keeps its filing order.
      $position: bottomPosition(),
      $description: input.description?.trim() ?? '',
      $priority: input.priority ?? 'medium',
      $tags: JSON.stringify(input.tags ?? []),
      $branch: branchName,
      $investigation: investigation,
      $checkpoint: checkpointNameFor(ref, workspace().config.checkpointPrefix),
      $at: at,
    });

  const task = requireTask(ref);
  addEvent(task.id, 'created', {
    toStatus: 'backlog',
    note: investigation ? `${title} (from ${investigation})` : title,
  });
  return task;
}

export interface UpdateInput {
  title?: string;
  description?: string;
  priority?: Priority;
  tags?: string[];
  /** Link the task to an investigation, or pass null to unlink it. */
  investigationRef?: string | null;
}

export function updateTask(ref: string, input: UpdateInput): Task {
  const task = requireTask(ref);

  const assignments: string[] = [];
  const params: Record<string, string | number | null> = { $ref: task.ref, $at: nowIso() };
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
  if (input.investigationRef !== undefined) {
    assignments.push('investigation_ref = $investigation');
    params.$investigation = input.investigationRef
      ? requireInvestigation(input.investigationRef).ref
      : null;
    changed.push('investigation');
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

/* ------------------------------------------------------------- list order */

/** One past the last position in use — where a newly filed task goes. */
function bottomPosition(): number {
  const row = getDb()
    .query<{ top: number | null }, []>('SELECT MAX(position) AS top FROM tasks')
    .get();
  return (row?.top ?? 0) + 1;
}

/**
 * Rearrange the given tasks into the given order.
 *
 * Only the positions those tasks already occupy are redistributed among them,
 * so this is a permutation and nothing outside `refs` moves. That is what makes
 * it safe to call from a filtered view: dragging within "Backlog" reshuffles the
 * backlog rows and leaves the in-progress rows interleaved between them exactly
 * where they were.
 */
export function reorderTasks(refs: string[]): Task[] {
  const tasks = refs.map((ref) => requireTask(ref));

  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.ref)) throw new Error(`Task '${task.ref}' listed twice in the new order.`);
    seen.add(task.ref);
  }
  if (tasks.length < 2) return tasks;

  const slots = tasks.map((task) => task.position).sort((left, right) => left - right);
  const assign = getDb().query('UPDATE tasks SET position = $position WHERE id = $id');

  getDb().transaction(() => {
    tasks.forEach((task, index) => assign.run({ $id: task.id, $position: slots[index]! }));
  })();

  return tasks.map((task) => requireTask(task.ref));
}

export type MoveTarget =
  | { to: 'top' | 'bottom' | 'up' | 'down' }
  | { to: 'before' | 'after'; ref: string };

/**
 * Move one task within the full (non-closed) list. Expressed against that list
 * rather than raw position arithmetic so `up` means "swap with the row above it
 * on screen" even when positions are sparse.
 */
export function moveTask(ref: string, target: MoveTarget): Task[] {
  const task = requireTask(ref);
  const order = listTasks().map((one) => one.ref);
  const from = order.indexOf(task.ref);
  if (from === -1) {
    throw new Error(`Task '${task.ref}' is closed and is not in the ordered list.`);
  }

  let to: number;
  if (target.to === 'before' || target.to === 'after') {
    const anchor = requireTask(target.ref);
    if (anchor.ref === task.ref) throw new Error('A task cannot be moved relative to itself.');
    const at = order.indexOf(anchor.ref);
    if (at === -1) throw new Error(`Task '${anchor.ref}' is closed and is not in the ordered list.`);
    // Removing the task first shifts everything after it up by one, so an
    // anchor below the task needs no further adjustment for 'before'.
    to = at + (target.to === 'after' ? 1 : 0) - (at > from ? 1 : 0);
  } else if (target.to === 'top') to = 0;
  else if (target.to === 'bottom') to = order.length - 1;
  else if (target.to === 'up') to = from - 1;
  else to = from + 1;

  to = Math.max(0, Math.min(order.length - 1, to));
  if (to === from) return listTasks();

  order.splice(to, 0, ...order.splice(from, 1));
  reorderTasks(order);
  return listTasks();
}

/* ----------------------------------------------------------- investigations */

interface InvestigationRow {
  id: number;
  ref: string;
  title: string;
  brief: string;
  findings: string;
  status: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function toInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    brief: row.brief,
    findings: row.findings,
    status: row.status as InvestigationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** Timestamp column each investigation status stamps on entry. */
const INVESTIGATION_TIMESTAMP: Partial<Record<InvestigationStatus, string>> = {
  investigating: 'started_at',
  complete: 'completed_at',
};

export function listInvestigations(filter?: { status?: InvestigationStatus }): Investigation[] {
  const params: Record<string, string> = {};
  if (filter?.status) params.$status = filter.status;
  const where = filter?.status ? 'WHERE status = $status' : '';

  return getDb()
    .query<InvestigationRow, typeof params>(
      `SELECT * FROM investigations ${where}
       ORDER BY CASE status
                  WHEN 'investigating' THEN 0
                  WHEN 'draft'         THEN 1
                  ELSE 2
                END,
                id DESC`,
    )
    .all(params)
    .map(toInvestigation);
}

export function findInvestigation(ref: string): Investigation | null {
  const row = getDb()
    .query<InvestigationRow, { $ref: string }>(
      'SELECT * FROM investigations WHERE ref = $ref COLLATE NOCASE',
    )
    .get({ $ref: ref });
  return row ? toInvestigation(row) : null;
}

export function requireInvestigation(ref: string): Investigation {
  const investigation = findInvestigation(ref);
  if (!investigation) throw new Error(`No investigation with ref '${ref}'.`);
  return investigation;
}

/** An investigation with the tasks it produced, closed ones included — a task
 *  taken all the way through is part of the answer. */
export function getInvestigationDetail(ref: string): InvestigationDetail {
  const investigation = requireInvestigation(ref);
  return {
    ...investigation,
    tasks: listTasks({ investigationRef: investigation.ref, includeClosed: true }),
  };
}

export function createInvestigation(input: { title: string; brief?: string }): Investigation {
  const title = input.title.trim();
  if (!title) throw new Error('An investigation needs a title.');

  const at = nowIso();
  const ref = nextInvestigationRef();

  getDb()
    .query(
      `INSERT INTO investigations (ref, title, brief, findings, status, created_at, updated_at)
       VALUES ($ref, $title, $brief, '', 'draft', $at, $at)`,
    )
    .run({ $ref: ref, $title: title, $brief: input.brief ?? '', $at: at });

  return requireInvestigation(ref);
}

/** Partial update: only the keys present are written, so an agent saving its
 *  findings never overwrites a brief the human edited while it was thinking. */
export function updateInvestigation(
  ref: string,
  input: { title?: string; brief?: string; findings?: string },
): Investigation {
  const investigation = requireInvestigation(ref);

  const assignments: string[] = [];
  const params: Record<string, string> = { $ref: investigation.ref, $at: nowIso() };

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error('An investigation needs a title.');
    assignments.push('title = $title');
    params.$title = title;
  }
  if (input.brief !== undefined) {
    assignments.push('brief = $brief');
    params.$brief = input.brief;
  }
  if (input.findings !== undefined) {
    assignments.push('findings = $findings');
    params.$findings = input.findings;
  }

  if (!assignments.length) return investigation;

  getDb()
    .query(`UPDATE investigations SET ${assignments.join(', ')}, updated_at = $at WHERE ref = $ref`)
    .run(params);

  return requireInvestigation(investigation.ref);
}

export function setInvestigationStatus(ref: string, status: InvestigationStatus): Investigation {
  const investigation = requireInvestigation(ref);
  if (investigation.status === status) return investigation;

  const stamp = INVESTIGATION_TIMESTAMP[status];
  const stampClause = stamp ? `, ${stamp} = $at` : '';

  getDb()
    .query(
      `UPDATE investigations SET status = $status, updated_at = $at${stampClause} WHERE ref = $ref`,
    )
    .run({ $status: status, $at: nowIso(), $ref: investigation.ref });

  return requireInvestigation(investigation.ref);
}

/** Deleting the question does not delete the answers: the tasks it filed stay,
 *  unlinked, because the work still needs doing. */
export function deleteInvestigation(ref: string): void {
  const investigation = requireInvestigation(ref);
  const db = getDb();
  db.query('UPDATE tasks SET investigation_ref = NULL WHERE investigation_ref = $ref')
    .run({ $ref: investigation.ref });
  db.query('DELETE FROM investigations WHERE id = $id').run({ $id: investigation.id });
}

/** Record that a task's work was included in a combined delivery branch. */
/** Correct a task's assigned branch when a legacy/generated name has since been
 * renamed in Git. Kept separate from ordinary task edits: branch assignment is
 * Git identity, not task metadata. */
export function updateTaskBranchName(ref: string, branchName: string): Task {
  const task = requireTask(ref);
  const at = nowIso();
  getDb().query('UPDATE tasks SET branch_name = $branch, updated_at = $at WHERE ref = $ref')
    .run({ $branch: validateBranchName(branchName), $at: at, $ref: task.ref });
  addEvent(task.id, 'note', { note: `Assigned branch updated to '${branchName}'.` });
  return requireTask(ref);
}

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
  combine_state: 'complete' | 'conflict';
  combine_pending_commits: string;
  combine_close_tasks: number;
  created_at: string;
  updated_at: string;
}

function toCombinedBranch(row: CombinedBranchRow): CombinedBranch {
  let taskRefs: string[] = [];
  let combinePendingCommits: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.task_refs);
    if (Array.isArray(parsed)) taskRefs = parsed.map(String);
    const pending: unknown = JSON.parse(row.combine_pending_commits);
    if (Array.isArray(pending)) combinePendingCommits = pending.map(String);
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
    combineState: row.combine_state,
    combinePendingCommits,
    combineCloseTasks: Boolean(row.combine_close_tasks),
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
  combineState?: 'complete' | 'conflict';
  combinePendingCommits?: string[];
  combineCloseTasks?: boolean;
}): CombinedBranch {
  const at = nowIso();
  getDb()
    .query(
      `INSERT INTO combined_branches (branch_name, base_branch, task_refs, combine_state, combine_pending_commits, combine_close_tasks, created_at, updated_at)
       VALUES ($name, $base, $refs, $state, $pending, $closeTasks, $at, $at)
       ON CONFLICT(branch_name) DO UPDATE
         SET base_branch = $base, task_refs = $refs, combine_state = $state, combine_pending_commits = $pending, combine_close_tasks = $closeTasks, updated_at = $at`,
    )
    .run({
      $name: input.branchName,
      $base: input.baseBranch,
      $refs: JSON.stringify(input.taskRefs),
      $state: input.combineState ?? 'complete',
      $pending: JSON.stringify(input.combinePendingCommits ?? []),
      $closeTasks: input.combineCloseTasks ? 1 : 0,
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
    combineState?: 'complete' | 'conflict';
  },
): CombinedBranch {
  requireCombinedBranch(branchName);

  const columns = {
    baseBranch: 'base_branch',
    prTitle: 'pr_title',
    prBody: 'pr_body',
    prUrl: 'pr_url',
    prNumber: 'pr_number',
    combineState: 'combine_state',
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

/** Rename the persisted delivery-branch record after Git has renamed the ref. */
export function renameCombinedBranch(branchName: string, newBranchName: string): CombinedBranch {
  requireCombinedBranch(branchName);
  const name = validateBranchName(newBranchName);
  if (name === branchName) return requireCombinedBranch(branchName);
  getDb().query(
    'UPDATE combined_branches SET branch_name = $newName, updated_at = $at WHERE branch_name = $name',
  ).run({ $newName: name, $name: branchName, $at: nowIso() });
  return requireCombinedBranch(name);
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
