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
