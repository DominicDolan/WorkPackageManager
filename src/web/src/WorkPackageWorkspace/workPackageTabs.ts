import type { WorkPackageDetail } from "@shared/types"

/**
 * The tabs a work package page draws after its fixed Tasks tab: one per
 * investigation, branch and run, in the order they were added.
 *
 * Keys are strings rather than objects so a tab keeps its identity across
 * refreshes — the detail is refetched on every change, and a panel keyed on a
 * fresh object would be torn down and rebuilt each time.
 */
export type TabKind = "investigation" | "branch" | "run"

export interface WorkPackageTab {
    key: string
    kind: TabKind
    label: string
    createdAt: string
}

export const TASKS_TAB = "tasks"
export const investigationTab = (ref: string) => `investigation:${ref}`
export const branchTab = (id: number) => `branch:${id}`
export const runTab = (id: number) => `run:${id}`

export function workPackageTabs(detail: WorkPackageDetail): WorkPackageTab[] {
    return [
        ...detail.investigations.map((investigation) => ({
            key: investigationTab(investigation.ref),
            kind: "investigation" as const,
            label: investigation.title,
            createdAt: investigation.createdAt,
        })),
        ...detail.branches.map((branch) => ({
            key: branchTab(branch.id),
            kind: "branch" as const,
            label: branch.label,
            createdAt: branch.createdAt,
        })),
        ...detail.workRuns.map((run) => ({
            key: runTab(run.id),
            kind: "run" as const,
            label: run.label,
            createdAt: run.createdAt,
        })),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}
