import type { Status } from "@shared/types"

const statusClasses: Record<Status, string> = {
    backlog: "status-backlog",
    in_progress: "status-progress",
    dev_complete: "status-review",
    verified: "status-verified",
    closed: "status-closed",
}

export function statusClass(status: Status): string {
    return statusClasses[status]
}
