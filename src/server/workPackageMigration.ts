import type { Database } from "bun:sqlite"

/** Rename storage without changing references, Git branches or historical logs.
 * Called inside the schema transaction, before creating any new tables. */
export function migrateWorkPackages(database: Database): void {
    const hasTable = (name: string) =>
        Boolean(
            database
                .query(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                )
                .get(name),
        )
    for (const [oldName, newName] of [
        ["task_groups", "work_packages"],
        ["group_runs", "work_package_runs"],
    ] as const) {
        if (hasTable(oldName)) {
            database.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`)
        }
    }
    for (const table of ["tasks", "work_package_runs"]) {
        const columns = database
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
        if (columns.some((column) => column.name === "group_ref")) {
            database.exec(
                `ALTER TABLE ${table} RENAME COLUMN group_ref TO work_package_ref`,
            )
        }
    }
    // Rebuild the table because its CHECK constraint also contains the old name.
    const noteSchema = database
        .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_links'",
        )
        .get()
    if (noteSchema?.sql.includes("'group'")) {
        database.exec(`CREATE TABLE work_package_note_links (
      subject_kind TEXT NOT NULL CHECK(subject_kind IN ('task', 'work-package')),
      subject_ref TEXT NOT NULL,
      note_path TEXT NOT NULL,
      attached_at TEXT NOT NULL,
      PRIMARY KEY (subject_kind, subject_ref, note_path)
    )`)
        database.exec(`INSERT INTO work_package_note_links
      SELECT CASE subject_kind WHEN 'group' THEN 'work-package' ELSE subject_kind END,
        subject_ref, note_path, attached_at FROM note_links`)
        database.exec("DROP TABLE note_links")
        database.exec(
            "ALTER TABLE work_package_note_links RENAME TO note_links",
        )
    }
    if (hasTable("agent_runs")) {
        database.exec(
            "UPDATE agent_runs SET subject_kind = 'work-package' WHERE subject_kind = 'group'",
        )
        database.exec(
            "UPDATE agent_runs SET command = 'work-package' WHERE command = 'work-group'",
        )
    }
    if (hasTable("counters")) {
        database.exec(`INSERT INTO counters (name, value)
      SELECT 'work-package', value FROM counters WHERE name = 'group'
      ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`)
        database.exec("DELETE FROM counters WHERE name = 'group'")
    }
}
