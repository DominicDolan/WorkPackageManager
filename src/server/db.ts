import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { workspace } from '../config/paths';
import { branchNameFor, groupBranchNameFor } from '../shared/types';

let db: Database | undefined;

/** Schema statements, applied in order. Each is idempotent, so opening an
 *  existing database is the same code path as creating a new one. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     ref              TEXT    NOT NULL UNIQUE,
     title            TEXT    NOT NULL,
     description      TEXT    NOT NULL DEFAULT '',
     status           TEXT    NOT NULL DEFAULT 'backlog',
     priority         TEXT    NOT NULL DEFAULT 'medium',
     -- Manual list order. 0 is a placeholder the migration pass replaces, so a
     -- row inserted without one still sorts deterministically until it does.
     position         INTEGER NOT NULL DEFAULT 0,
     tags             TEXT    NOT NULL DEFAULT '[]',
     -- Duration on the plan, in abstract units. One is "a task".
     estimate_units   INTEGER NOT NULL DEFAULT 1,
     investigation_ref TEXT,
     branch_name      TEXT,
     checkpoint_name  TEXT,
     created_at       TEXT    NOT NULL,
     updated_at       TEXT    NOT NULL,
     started_at       TEXT,
     dev_completed_at TEXT,
     verified_at      TEXT,
     closed_at        TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS task_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     type        TEXT    NOT NULL,
     from_status TEXT,
     to_status   TEXT,
     note        TEXT,
     created_at  TEXT    NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id)`,

  // "task_id waits for depends_on_id". One row per edge, both sides cascading:
  // deleting a task must not leave an edge pointing at a ref nothing can
  // resolve. The composite primary key makes re-adding an existing edge a
  // no-op rather than a duplicate.
  `CREATE TABLE IF NOT EXISTS task_dependencies (
     task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     created_at    TEXT    NOT NULL,
     PRIMARY KEY (task_id, depends_on_id)
   )`,

  // The reverse direction — "what is waiting on this task" — is asked as often
  // as the forward one, and the primary key only indexes the forward one.
  `CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker
     ON task_dependencies(depends_on_id)`,

  // One row per `aio-vr before` / `aio-vr after` invocation.
  `CREATE TABLE IF NOT EXISTS checkpoint_runs (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     checkpoint_name TEXT    NOT NULL,
     phase           TEXT    NOT NULL,
     exit_code       INTEGER NOT NULL DEFAULT 0,
     git_head        TEXT,
     git_dirty       INTEGER,
     scenario_count  INTEGER NOT NULL DEFAULT 0,
     raw_json        TEXT,
     -- The --scenario/--folder filters this run was captured with. The after
     -- phase must reuse them, or aio-vr sees the unfiltered suite as drift.
     selection_json  TEXT,
     created_at      TEXT    NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_runs_task ON checkpoint_runs(task_id, id)`,

  // One row per scenario within a run. Image paths stay repo-root-relative,
  // exactly as aio-vr reports them, so they survive the repo moving.
  `CREATE TABLE IF NOT EXISTS checkpoint_comparisons (
     id                       INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id                   INTEGER NOT NULL REFERENCES checkpoint_runs(id) ON DELETE CASCADE,
     scenario                 TEXT    NOT NULL,
     description              TEXT,
     status                   TEXT    NOT NULL,
     percent_changed          REAL,
     pixel_diff_count         INTEGER,
     total_pixels             INTEGER,
     before_path              TEXT,
     after_path               TEXT,
     diff_path                TEXT,
     browser_log_status       TEXT,
     browser_log_change_count INTEGER
   )`,

  `CREATE INDEX IF NOT EXISTS idx_comparisons_run ON checkpoint_comparisons(run_id)`,

  // Monotonic counters behind the T-<n> and I-<n> refs. Kept separate from the
  // row ids so deleting a record never lets a ref be reused.
  `CREATE TABLE IF NOT EXISTS counters (
     name  TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`,

  // A question written down before the investigating happens. Tasks point back
  // at one by ref (tasks.investigation_ref) rather than by foreign key: the
  // tasks are the durable output and must survive the investigation's deletion.
  `CREATE TABLE IF NOT EXISTS investigations (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     ref          TEXT    NOT NULL UNIQUE,
     title        TEXT    NOT NULL,
     brief        TEXT    NOT NULL DEFAULT '',
     findings     TEXT    NOT NULL DEFAULT '',
     status       TEXT    NOT NULL DEFAULT 'draft',
     created_at   TEXT    NOT NULL,
     updated_at   TEXT    NOT NULL,
     started_at   TEXT,
     completed_at TEXT
   )`,

  // A named bundle of tasks. Membership is a column on `tasks`, not a join
  // table, because a task belongs to at most one group — expressing that in the
  // schema is what keeps it true. Tasks point back by ref rather than by foreign
  // key, matching investigations: deleting the grouping must not delete work.
  `CREATE TABLE IF NOT EXISTS task_groups (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     ref               TEXT    NOT NULL UNIQUE,
     name              TEXT    NOT NULL,
     description       TEXT    NOT NULL DEFAULT '',
     color             TEXT    NOT NULL DEFAULT '',
     -- The branch this group's work is built on. Every group has one, so it is
     -- backfilled rather than left null on an older database.
     branch_name       TEXT    NOT NULL DEFAULT '',
     position          INTEGER NOT NULL DEFAULT 0,
     -- Set when the group was created to hold an investigation's output, which
     -- is also what makes that auto-grouping idempotent.
     investigation_ref TEXT,
     created_at        TEXT    NOT NULL,
     updated_at        TEXT    NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_task_groups_investigation
     ON task_groups(investigation_ref)`,

  // One row per delivery branch produced by combining task branches. Deliberately
  // NOT a foreign key to tasks: combining usually closes the tasks, and a task
  // may later be deleted, but the branch and its PR outlive both.
  `CREATE TABLE IF NOT EXISTS combined_branches (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     branch_name TEXT    NOT NULL UNIQUE,
     base_branch TEXT,
     remote_branch TEXT,
     task_refs   TEXT    NOT NULL DEFAULT '[]',
     pr_title    TEXT,
     pr_body     TEXT,
     pr_url      TEXT,
     pr_number   INTEGER,
     combine_state TEXT  NOT NULL DEFAULT 'complete',
     combine_pending_commits TEXT NOT NULL DEFAULT '[]',
     combine_close_tasks INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT    NOT NULL,
     updated_at  TEXT    NOT NULL
   )`,

  // One row per agent launched from the UI. Deliberately not a foreign key to
  // anything: a run is about an issue as often as a task, and the record of
  // "an agent was pointed at this" should outlive whatever it was pointed at.
  // A `terminal` run's output belongs to the terminal; only `print` runs have a
  // log, and the log lives on disk beside the database rather than inside it.
  `CREATE TABLE IF NOT EXISTS agent_runs (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     harness      TEXT    NOT NULL,
     model        TEXT    NOT NULL DEFAULT '',
     mode         TEXT    NOT NULL,
     command      TEXT    NOT NULL,
     subject_kind TEXT    NOT NULL,
     subject_ref  TEXT    NOT NULL,
     prompt       TEXT    NOT NULL,
     argv_json    TEXT    NOT NULL DEFAULT '[]',
     pid          INTEGER,
     -- The conversation id used by the harness, so the session can be reopened.
     -- Usually supplied at launch; captured from output when Codex generates it.
     session_id   TEXT,
     status       TEXT    NOT NULL,
     exit_code    INTEGER,
     log_path     TEXT,
     created_at   TEXT    NOT NULL,
     finished_at  TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_agent_runs_subject ON agent_runs(subject_kind, subject_ref, id)`,

  // One row per unattended run of a whole group. This is the loop's memory: the
  // launch settings every task is worked with, which task is in flight, and what
  // has already been carried to Dev Complete. Not a foreign key to `agent_runs`
  // for the same reason that table has none — the record of what was attempted
  // should outlive whatever it was attempted against.
  `CREATE TABLE IF NOT EXISTS group_runs (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     group_ref       TEXT    NOT NULL,
     harness         TEXT    NOT NULL,
     model           TEXT    NOT NULL DEFAULT '',
     permission_mode TEXT    NOT NULL,
     extra           TEXT    NOT NULL DEFAULT '',
     status          TEXT    NOT NULL,
     -- The agent_runs row in flight, and what it is pointed at. Both survive the
     -- loop ending, because "where did it get to" is the first thing asked of a
     -- run that stopped.
     current_run_id  INTEGER,
     current_ref     TEXT,
     worked_json     TEXT    NOT NULL DEFAULT '[]',
     excluded_json   TEXT    NOT NULL DEFAULT '[]',
     stop_reason     TEXT    NOT NULL DEFAULT '',
     created_at      TEXT    NOT NULL,
     finished_at     TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_group_runs_group ON group_runs(group_ref, id)`,
];

/**
 * Columns added after a database may already exist. `CREATE TABLE IF NOT EXISTS`
 * silently skips them on an older file, so add them explicitly.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'checkpoint_runs', column: 'selection_json', definition: 'TEXT' },
  // Completed legacy tasks deliberately remain unassigned. Backlog and active
  // legacy tasks are deterministically backfilled after this column is added.
  { table: 'tasks', column: 'branch_name', definition: 'TEXT' },
  { table: 'tasks', column: 'closed_at', definition: 'TEXT' },
  // Tasks filed before Investigations existed simply have none.
  { table: 'tasks', column: 'investigation_ref', definition: 'TEXT' },
  // Tasks filed before groups existed are loose, which is exactly right: a
  // group is something a human or an investigation puts them into.
  { table: 'tasks', column: 'group_ref', definition: 'TEXT' },
  // Manual list order. Existing rows all land on 0 and are backfilled below.
  { table: 'tasks', column: 'position', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Plan duration. Existing rows land on one unit, which is what they would
  // have been estimated at anyway.
  { table: 'tasks', column: 'estimate_units', definition: 'INTEGER NOT NULL DEFAULT 1' },
  // Groups created before they had branches are backfilled below, because a
  // group without a branch has nothing for its tasks to be cut from.
  { table: 'task_groups', column: 'branch_name', definition: "TEXT NOT NULL DEFAULT ''" },
  // Runs launched before sessions were tracked have none, and cannot be
  // resumed — the id was the harness's to pick and it was never recorded.
  { table: 'agent_runs', column: 'session_id', definition: 'TEXT' },
  { table: 'combined_branches', column: 'combine_state', definition: "TEXT NOT NULL DEFAULT 'complete'" },
  { table: 'combined_branches', column: 'combine_pending_commits', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'combined_branches', column: 'combine_close_tasks', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // The last pre-PR check run, as a ChecksReport JSON blob. One row, one report:
  // only the latest matters, because an older one describes code that has moved.
  { table: 'combined_branches', column: 'checks_json', definition: 'TEXT' },
  // Set by an investigation when it files a task; null on everything filed
  // before this existed, and on any task nobody has judged.
  { table: 'tasks', column: 'recommended_tier', definition: 'TEXT' },
  // Null means push to origin under the same name as the local branch, which
  // is the historical default.
  { table: 'combined_branches', column: 'remote_branch', definition: 'TEXT' },
  // Older unattended runs included every queued task.
  { table: 'group_runs', column: 'excluded_json', definition: "TEXT NOT NULL DEFAULT '[]'" },
];

/** Indexes over columns that ADDED_COLUMNS may have only just created, so they
 *  cannot live in SCHEMA — that runs before the migrations. */
const POST_MIGRATION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_tasks_investigation ON tasks(investigation_ref)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_ref)',
];

function applyColumnMigrations(database: Database): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);

    if (existing.length && !existing.includes(column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // Preserve historical completed records as-is, but make work still waiting
  // to happen (backlog or in progress) branch-addressable on upgrade.
  const unassigned = database
    .query<{ ref: string; title: string }, []>(
      "SELECT ref, title FROM tasks WHERE branch_name IS NULL AND status IN ('backlog', 'in_progress')",
    )
    .all();
  const backfill = database.query('UPDATE tasks SET branch_name = $branch WHERE ref = $ref');
  for (const task of unassigned) {
    backfill.run({
      $ref: task.ref,
      $branch: branchNameFor(task.ref, task.title, workspace().config.branchPrefix),
    });
  }

  backfillGroupBranches(database);
  backfillPositions(database);
}

/**
 * Give every group a branch name. `''` is the never-assigned sentinel — nothing
 * writes it deliberately — so this is idempotent and also repairs a row that
 * somehow slipped in without one.
 */
function backfillGroupBranches(database: Database): void {
  const rows = database
    .query<{ ref: string; name: string }, []>("SELECT ref, name FROM task_groups WHERE branch_name = ''")
    .all();
  if (!rows.length) return;

  const prefix = workspace().config.groupBranchPrefix;
  const assign = database.query('UPDATE task_groups SET branch_name = $branch WHERE ref = $ref');
  database.transaction(() => {
    for (const group of rows) {
      assign.run({ $ref: group.ref, $branch: groupBranchNameFor(group.ref, group.name, prefix) });
    }
  })();
}

/**
 * Give every task a manual list position. `position = 0` is the never-assigned
 * sentinel — nothing ever writes it deliberately — so this is idempotent and
 * also repairs a row that somehow slipped in without one.
 *
 * Unpositioned rows are appended in the ordering the list used before manual
 * order existed (in-progress first, then by priority, newest first), so the
 * first list a user sees after upgrading looks exactly like the last one they
 * saw before it.
 */
function backfillPositions(database: Database): void {
  const pending = database
    .query<{ id: number }, []>(
      `SELECT id FROM tasks
        WHERE position = 0
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
    .all();
  if (!pending.length) return;

  const highest =
    database.query<{ top: number | null }, []>('SELECT MAX(position) AS top FROM tasks').get()
      ?.top ?? 0;

  const assign = database.query('UPDATE tasks SET position = $position WHERE id = $id');
  database.transaction(() => {
    pending.forEach((task, index) => {
      assign.run({ $id: task.id, $position: highest + index + 1 });
    });
  })();
}

/**
 * Combines performed before `combined_branches` existed left only a note on each
 * task. Reconstruct those rows so history does not start empty — the note text
 * is written in exactly one place (`recordCombinedBranch`), so parsing it is
 * reliable. Task order comes from the event id, which is the order they were
 * cherry-picked in.
 */
function backfillCombinedBranches(database: Database): void {
  const rows = database
    .query<{ ref: string; note: string; created_at: string }, []>(
      `SELECT t.ref AS ref, e.note AS note, e.created_at AS created_at
         FROM task_events e
         JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'note' AND e.note LIKE 'Included in combined branch %'
        ORDER BY e.id`,
    )
    .all();

  const byBranch = new Map<string, { refs: string[]; at: string }>();
  for (const row of rows) {
    const name = /^Included in combined branch '(.+)'\.$/.exec(row.note)?.[1];
    if (!name) continue;

    const entry = byBranch.get(name) ?? { refs: [], at: row.created_at };
    if (!entry.refs.includes(row.ref)) entry.refs.push(row.ref);
    byBranch.set(name, entry);
  }

  const insert = database.query(
    `INSERT INTO combined_branches (branch_name, base_branch, task_refs, created_at, updated_at)
     VALUES ($name, NULL, $refs, $at, $at)
     ON CONFLICT(branch_name) DO NOTHING`,
  );
  for (const [name, entry] of byBranch) {
    insert.run({ $name: name, $refs: JSON.stringify(entry.refs), $at: entry.at });
  }
}

export function getDb(): Database {
  if (db) return db;

  const { dbPath } = workspace();
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const statement of SCHEMA) db.exec(statement);
  applyColumnMigrations(db);
  for (const statement of POST_MIGRATION_INDEXES) db.exec(statement);
  backfillCombinedBranches(db);

  return db;
}

/** Bump one of the monotonic counters and return its new value. */
function nextCounter(name: string): number {
  const row = getDb()
    .query<{ value: number }, { $name: string }>(
      `INSERT INTO counters (name, value) VALUES ($name, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get({ $name: name });

  return row!.value;
}

/** Next task ref, e.g. `T-7`. */
export function nextRef(): string {
  return `T-${nextCounter('task')}`;
}

/** Next investigation ref, e.g. `I-3`. Counted separately from tasks so the two
 *  sequences never interleave. */
export function nextInvestigationRef(): string {
  return `I-${nextCounter('investigation')}`;
}

/** Next group ref, e.g. `G-2`. Its own counter for the same reason. */
export function nextGroupRef(): string {
  return `G-${nextCounter('group')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
