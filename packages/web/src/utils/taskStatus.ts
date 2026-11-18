import type { Task } from "@work-task-manager/shared"

/** The timestamp at which a task entered its current status. */
export function statusSince(task: Task): { verb: string; at: string } | null {
    const at = {
        backlog: task.createdAt,
        in_progress: task.startedAt,
        dev_complete: task.devCompletedAt,
        verified: task.verifiedAt,
        closed: task.closedAt,
    }[task.status]
    const verb = {
        backlog: "Created",
        in_progress: "Started",
        dev_complete: "Dev complete",
        verified: "Verified",
        closed: "Closed",
    }[task.status]
    return at ? { verb, at } : null
}

export function statusDetail(task: Task): string {
    const since = statusSince(task)
    return since
        ? `${since.verb} ${timeAgo(since.at)}`
        : `Updated ${timeAgo(task.updatedAt)}`
}

function timeAgo(iso: string): string {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    const units: [number, string][] = [
        [60 * 60 * 24 * 365, "y"],
        [60 * 60 * 24 * 30, "mo"],
        [60 * 60 * 24, "d"],
        [60 * 60, "h"],
        [60, "m"],
    ]
    for (const [size, label] of units) {
        if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`
    }
    return "just now"
}
