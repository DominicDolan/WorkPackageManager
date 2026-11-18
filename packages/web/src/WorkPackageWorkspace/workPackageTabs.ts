import type { WorkPackageDetail } from "@work-task-manager/shared"

/**
 * The tabs a work package page draws after its fixed Tasks tab: one per
 * investigation, branch and run, in the order they were added.
 *
 * Keys are strings rather than objects so a tab keeps its identity across
 * refreshes — the detail is refetched on every change, and a panel keyed on a
 * fresh object would be torn down and rebuilt each time.
 */
export type TabKind = "investigation" | "branch" | "run"

export type WorkPackageTab = WorkPackageDetail["tabs"][number]

export const TASKS_TAB = "tasks"
export const investigationTab = (ref: string) => `investigation:${ref}`
export const branchTab = (id: number) => `branch:${id}`
export const runTab = (id: number) => `run:${id}`

/** The server orders a package's tabs (`WorkPackageDetail.tabs`); this only
 *  narrows the type for the page. */
export function workPackageTabs(detail: WorkPackageDetail): WorkPackageTab[] {
    return detail.tabs
}
