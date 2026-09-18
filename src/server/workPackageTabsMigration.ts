import type { Database } from "bun:sqlite"
import { workPackageBranchNameFor } from "../shared/types"

const NAME = "work-package-tabs"

/**
 * Move each work package's single investigation and single branch into the rows
 * that now hold any number of them.
 *
 * Before this, a work package *was* one branch (`work_packages.branch_name`) and
 * pointed at one investigation (`work_packages.investigation_ref`). Afterwards the
 * investigation points back at its work package, and the branch is a
 * `work_package_branches` row carrying every task the work package had — the
 * finished ones included, because those are already merged there.
 *
 * Nothing moves in Git: the branch keeps its name, and a work package whose branch
 * was never created still has none.
 *
 * Runs once, recorded in `schema_migrations`. A plain "has no branch rows" test
 * would not do: deleting a work package's last branch tab would bring it back on
 * the next start.
 */
export function migrateWorkPackageTabs(
    database: Database,
    branchPrefix: string,
): void {
    const applied = database
        .query("SELECT 1 FROM schema_migrations WHERE name = ?")
        .get(NAME)
    if (applied) return

    const columns = new Set(
        database
            .query<{ name: string }, []>("PRAGMA table_info(work_packages)")
            .all()
            .map((column) => column.name),
    )
    const at = new Date().toISOString()

    if (columns.has("investigation_ref")) {
        database.exec(`UPDATE investigations
            SET work_package_ref = (
                SELECT w.ref FROM work_packages w
                 WHERE w.investigation_ref = investigations.ref COLLATE NOCASE
                 ORDER BY w.id LIMIT 1)
          WHERE work_package_ref IS NULL`)
    }

    // A description with no investigation behind it was the brief of a work
    // package made before they had one. It becomes an investigation rather than
    // being dropped with the column.
    if (columns.has("description")) {
        const orphaned = database
            .query<{ ref: string; name: string; description: string }, []>(
                `SELECT ref, name, description FROM work_packages w
                  WHERE TRIM(description) != ''
                    AND NOT EXISTS (SELECT 1 FROM investigations i
                                     WHERE i.work_package_ref = w.ref COLLATE NOCASE)
                  ORDER BY id`,
            )
            .all()
        const bump = database.query<{ value: number }, [string]>(
            `INSERT INTO counters (name, value) VALUES (?, 1)
             ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`,
        )
        const insert = database.query(
            `INSERT INTO investigations (ref, title, brief, findings, status, work_package_ref, created_at, updated_at)
             VALUES ($ref, $title, $brief, '', 'draft', $workPackage, $at, $at)`,
        )
        for (const workPackage of orphaned) {
            insert.run({
                $ref: `I-${bump.get("investigation")!.value}`,
                $title: workPackage.name,
                $brief: workPackage.description,
                $workPackage: workPackage.ref,
                $at: at,
            })
        }
    }

    if (columns.has("branch_name")) {
        const packages = database
            .query<{ ref: string; name: string; branch_name: string }, []>(
                "SELECT ref, name, branch_name FROM work_packages ORDER BY id",
            )
            .all()
        const insertBranch = database.query<
            { id: number },
            Record<string, string>
        >(
            `INSERT INTO work_package_branches
               (work_package_ref, label, branch_name, base_branch, origin, created_at, updated_at)
             VALUES ($ref, 'Branch', $branch, NULL, 'new', $at, $at)
             ON CONFLICT(branch_name) DO NOTHING
             RETURNING id`,
        )
        const assign = database.query(
            `INSERT INTO branch_tasks (branch_id, task_ref, created_at)
             SELECT $branch, ref, $at FROM tasks
              WHERE work_package_ref = $ref COLLATE NOCASE
              ORDER BY position, id`,
        )
        for (const workPackage of packages) {
            const branch =
                workPackage.branch_name ||
                workPackageBranchNameFor(
                    workPackage.ref,
                    workPackage.name,
                    branchPrefix,
                )
            const row = insertBranch.get({
                $ref: workPackage.ref,
                $branch: branch,
                $at: at,
            })
            if (row)
                assign.run({ $branch: row.id, $ref: workPackage.ref, $at: at })
        }
    }

    database
        .query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(NAME, at)
}
