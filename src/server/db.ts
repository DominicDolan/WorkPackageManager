import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { workspace } from '../config/paths';
import { branchNameFor } from '../shared/types';

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
     tags             TEXT    NOT NULL DEFAULT '[]',
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

  // Monotonic counter behind the T-<n> refs. Kept separate from tasks.id so
  // deleting a task never lets a ref be reused.
  `CREATE TABLE IF NOT EXISTS counters (
     name  TEXT PRIMARY KEY,
     value INTEGER NOT NULL
   )`,

  // One row per delivery branch produced by combining task branches. Deliberately
  // NOT a foreign key to tasks: combining usually closes the tasks, and a task
  // may later be deleted, but the branch and its PR outlive both.
  `CREATE TABLE IF NOT EXISTS combined_branches (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     branch_name TEXT    NOT NULL UNIQUE,
     base_branch TEXT,
     task_refs   TEXT    NOT NULL DEFAULT '[]',
     pr_title    TEXT,
     pr_body     TEXT,
     pr_url      TEXT,
     pr_number   INTEGER,
     created_at  TEXT    NOT NULL,
     updated_at  TEXT    NOT NULL
   )`,
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
  backfillCombinedBranches(db);

  return db;
}

/** Next task ref, e.g. `T-7`. */
export function nextRef(): string {
  const database = getDb();
  const row = database
    .query<{ value: number }, []>(
      `INSERT INTO counters (name, value) VALUES ('task', 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get();

  return `T-${row!.value}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
