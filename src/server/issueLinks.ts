import { getDb, nowIso } from "./db"
import { readIssue } from "./issues"

/**
 * Issues attached to a work package. The issue itself stays a read-only JSON
 * file in the notes folder; this only records the reference to it.
 */
export function issueLinkRows(
    workPackageRef: string,
): { id: string; attachedAt: string }[] {
    return getDb()
        .query<{ issue_id: string; attached_at: string }, { $ref: string }>(
            `SELECT issue_id, attached_at FROM issue_links
        WHERE work_package_ref = $ref COLLATE NOCASE
        ORDER BY attached_at DESC, issue_id ASC`,
        )
        .all({ $ref: workPackageRef })
        .map((row) => ({ id: row.issue_id, attachedAt: row.attached_at }))
}

export function attachIssue(workPackageRef: string, issueId: string): void {
    // Throws for an id that names nothing, rather than storing a dead link.
    const issue = readIssue(issueId)
    getDb()
        .query(
            `INSERT OR IGNORE INTO issue_links (work_package_ref, issue_id, attached_at)
       VALUES ($ref, $id, $at)`,
        )
        .run({ $ref: workPackageRef, $id: issue.id, $at: nowIso() })
}

export function detachIssue(workPackageRef: string, issueId: string): void {
    getDb()
        .query(
            `DELETE FROM issue_links
        WHERE work_package_ref = $ref COLLATE NOCASE AND issue_id = $id`,
        )
        .run({ $ref: workPackageRef, $id: issueId })
}

export function detachAllIssues(workPackageRef: string): void {
    getDb()
        .query(
            "DELETE FROM issue_links WHERE work_package_ref = $ref COLLATE NOCASE",
        )
        .run({ $ref: workPackageRef })
}
