import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { migrateWorkPackages } from "./workPackageMigration"

describe("work package storage upgrade", () => {
    test("preserves legacy references, branches, membership and run history", () => {
        const db = new Database(":memory:")
        try {
            db.exec(`
        CREATE TABLE task_groups (id INTEGER PRIMARY KEY, ref TEXT, branch_name TEXT);
        INSERT INTO task_groups VALUES (7, 'G-7', 'group/g-7-existing-work');
        CREATE TABLE tasks (ref TEXT, group_ref TEXT);
        INSERT INTO tasks VALUES ('T-1', 'G-7'), ('T-2', NULL);
        CREATE TABLE group_runs (id INTEGER PRIMARY KEY, group_ref TEXT, worked_json TEXT);
        INSERT INTO group_runs VALUES (3, 'G-7', '["T-1"]');
        CREATE TABLE agent_runs (command TEXT, subject_kind TEXT, subject_ref TEXT, prompt TEXT);
        INSERT INTO agent_runs VALUES ('work-group', 'group', 'G-7', 'Original group instructions');
        CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER);
        INSERT INTO counters VALUES ('group', 7), ('task', 2);
      `)
            db.transaction(() => migrateWorkPackages(db))()
            // Opening the workspace again must be harmless.
            db.transaction(() => migrateWorkPackages(db))()
            expect(db.query("SELECT * FROM work_packages").get()).toEqual({
                id: 7,
                ref: "G-7",
                branch_name: "group/g-7-existing-work",
            })
            expect(db.query("SELECT * FROM tasks ORDER BY ref").all()).toEqual([
                { ref: "T-1", work_package_ref: "G-7" },
                { ref: "T-2", work_package_ref: null },
            ])
            expect(db.query("SELECT * FROM work_package_runs").get()).toEqual({
                id: 3,
                work_package_ref: "G-7",
                worked_json: '["T-1"]',
            })
            expect(db.query("SELECT * FROM agent_runs").get()).toEqual({
                command: "work-package",
                subject_kind: "work-package",
                subject_ref: "G-7",
                prompt: "Original group instructions",
            })
            expect(
                db
                    .query(
                        "SELECT value FROM counters WHERE name = 'work-package'",
                    )
                    .get(),
            ).toEqual({ value: 7 })
        } finally {
            db.close()
        }
    })

    test("accepts an empty database before schema creation", () => {
        const db = new Database(":memory:")
        try {
            expect(() => migrateWorkPackages(db)).not.toThrow()
        } finally {
            db.close()
        }
    })
})
