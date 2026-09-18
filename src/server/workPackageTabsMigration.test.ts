import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { migrateWorkPackageTabs } from "./workPackageTabsMigration"

describe("work package tabs upgrade", () => {
    test("moves each work package's investigation and branch into their own rows, once", () => {
        const db = new Database(":memory:")
        try {
            db.exec(`
        CREATE TABLE work_packages (id INTEGER PRIMARY KEY, ref TEXT, name TEXT,
          description TEXT, branch_name TEXT, investigation_ref TEXT);
        INSERT INTO work_packages VALUES
          (1, 'WP-1', 'Search rework', 'old', 'feature/wp-1-search', 'I-2'),
          (2, 'WP-2', 'Never branched', 'Only a description', '', NULL);
        CREATE TABLE investigations (ref TEXT, title TEXT, brief TEXT, findings TEXT,
          status TEXT, work_package_ref TEXT, created_at TEXT, updated_at TEXT);
        INSERT INTO investigations (ref, work_package_ref) VALUES ('I-2', NULL), ('I-3', NULL);
        CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER);
        INSERT INTO counters VALUES ('investigation', 3);
        CREATE TABLE tasks (id INTEGER PRIMARY KEY, ref TEXT, work_package_ref TEXT, position INTEGER);
        INSERT INTO tasks VALUES (1, 'T-1', 'WP-1', 2), (2, 'T-2', 'WP-1', 1), (3, 'T-3', NULL, 3);
        CREATE TABLE work_package_branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT, work_package_ref TEXT, label TEXT,
          branch_name TEXT UNIQUE COLLATE NOCASE, base_branch TEXT, origin TEXT,
          created_at TEXT, updated_at TEXT);
        CREATE TABLE branch_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER,
          task_ref TEXT, created_at TEXT, UNIQUE (branch_id, task_ref));
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT);
      `)
            db.transaction(() => migrateWorkPackageTabs(db, "feature/"))()

            // WP-1's description is its linked investigation's mirror, so it is
            // not copied; WP-2's is all it has, so it becomes one.
            expect(
                db
                    .query(
                        "SELECT ref, title, brief, work_package_ref FROM investigations",
                    )
                    .all(),
            ).toEqual([
                {
                    ref: "I-2",
                    title: null,
                    brief: null,
                    work_package_ref: "WP-1",
                },
                {
                    ref: "I-3",
                    title: null,
                    brief: null,
                    work_package_ref: null,
                },
                {
                    ref: "I-4",
                    title: "Never branched",
                    brief: "Only a description",
                    work_package_ref: "WP-2",
                },
            ])
            expect(
                db
                    .query(
                        "SELECT id, work_package_ref, label, branch_name FROM work_package_branches ORDER BY id",
                    )
                    .all(),
            ).toEqual([
                {
                    id: 1,
                    work_package_ref: "WP-1",
                    label: "Branch",
                    branch_name: "feature/wp-1-search",
                },
                {
                    id: 2,
                    work_package_ref: "WP-2",
                    label: "Branch",
                    branch_name: "feature/wp-2-never-branched",
                },
            ])
            // Queue order, and only the work package's own tasks.
            expect(
                db
                    .query(
                        "SELECT branch_id, task_ref FROM branch_tasks ORDER BY id",
                    )
                    .all(),
            ).toEqual([
                { branch_id: 1, task_ref: "T-2" },
                { branch_id: 1, task_ref: "T-1" },
            ])

            // A branch tab deleted after the upgrade must stay deleted.
            db.exec("DELETE FROM work_package_branches WHERE id = 2")
            db.transaction(() => migrateWorkPackageTabs(db, "feature/"))()
            expect(
                db
                    .query("SELECT COUNT(*) AS n FROM work_package_branches")
                    .get(),
            ).toEqual({ n: 1 })
        } finally {
            db.close()
        }
    })
})
