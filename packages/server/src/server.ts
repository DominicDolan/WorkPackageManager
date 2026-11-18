/**
 * The API as one `Request -> Response` function, plus the startup work a
 * process serving it must do once. Routes live in `routes/`, one module per
 * resource; the logic they call lives in `@work-task-manager/core`.
 */
import { reconcileRuns } from "@work-task-manager/core/agents"
import { lazyWorkspace } from "@work-task-manager/core/config/paths"
import { reconcilePipelines } from "@work-task-manager/core/workPackagePipeline"
import { reconcileWorkPackageRuns } from "@work-task-manager/core/workPackageRuns"
import { announceChange, ensureWatchers } from "@work-task-manager/core/watch"
import { errorResponse } from "./http"
import { router, routes } from "./routes"

export { API_VERSION } from "./routes"
export { routes }

const ws = lazyWorkspace()
export { ws as serverWorkspace }

/** Every route's method, path and summary: what `GET /api/routes` serves. */
export function describeRoutes() {
    return router.describe()
}

/**
 * Answer one `/api/*` request. This is the whole API as a plain
 * `Request -> Response` function, so it can be mounted inside any Bun (or
 * Fetch-API) server a repository already runs. `startServer` is a thin
 * wrapper that adds static UI hosting and CORS around it.
 */
export async function handleApiRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
        const response = await router.handle(request, url, "/api")
        // Anything that succeeded and was not a read changed something. The file
        // watchers see these writes too; saying so directly is what keeps live
        // updates working on a filesystem whose change notifications do not.
        if (request.method !== "GET" && response.ok) {
            announceChange(
                url.pathname.startsWith("/api/notes") ? "notes" : "tasks",
            )
        }
        return response
    } catch (error) {
        return errorResponse(error)
    }
}

let started = false

/**
 * Settle state left behind by a previous process and start the file watchers.
 * Idempotent; `startServer` calls it, and so must anything that mounts
 * `handleApiRequest` itself.
 */
export function prepareWorkspace(): void {
    if (started) return
    started = true
    // Headless agent runs are children of this process, so a restart ended any that
    // were in flight. Settle those rows before anything can read them — and the
    // work package runs that were driving some of them, which are stopped rather than
    // picked up again: relaunching agents at boot is not a decision a restart makes.
    reconcileRuns()
    reconcileWorkPackageRuns()
    reconcilePipelines()

    // Start watching before the first tab connects, so the opening revisions a
    // client is handed are already moving with the workspace.
    ensureWatchers()
}
