import type { Task } from "@work-task-manager/shared"

/** "Started 2h ago". The server says which moment and what to call it
 *  (`statusSince`); only "how long ago" is worked out here, against the clock. */
export function statusDetail(task: Task): string {
    const since = task.statusSince
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
