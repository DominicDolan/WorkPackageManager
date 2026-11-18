import { existsSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import {
    API_VERSION,
    describeRoutes,
    handleApiRequest,
    prepareWorkspace,
    routes,
    serverWorkspace as ws,
} from "./server"
import { resolveUi, type ResolveUiOptions, type ResolvedUi } from "./ui"

export {
    API_VERSION,
    describeRoutes,
    handleApiRequest,
    prepareWorkspace,
    routes,
}
export {
    defaultUi,
    resolveUi,
    type ResolvedUi,
    type ResolveUiOptions,
} from "./ui"

export interface StartServerOptions {
    /** Defaults to `TASKS_API_PORT`, then the workspace's `apiPort`. */
    port?: number
    /** Which UI to host. Pass `false` to serve the API alone. */
    ui?: ResolveUiOptions | false
    /** Origins allowed cross-origin, on top of the workspace's `ui.origins`. */
    origins?: string[]
    /** Print where everything is. Defaults to true. */
    log?: boolean
}

/** Serve the API under `/api`, and a static single-page UI at everything else. */
export function startServer(options: StartServerOptions = {}) {
    prepareWorkspace()

    const port =
        options.port ?? Number(process.env.TASKS_API_PORT ?? ws.config.apiPort)
    const ui = options.ui === false ? null : resolveUi(ws, options.ui)
    const origins = new Set([
        ...(ws.config.ui?.origins ?? []),
        ...(options.origins ?? []),
    ])

    const withCors = (request: Request, response: Response): Response => {
        const origin = request.headers.get("origin")
        if (!origin || !origins.has(origin)) return response
        response.headers.set("access-control-allow-origin", origin)
        response.headers.set("vary", "origin")
        return response
    }

    const server = Bun.serve({
        port,
        // Checkpoint captures drive a real browser through every scenario, which
        // comfortably outlives the default request timeout.
        idleTimeout: 240,
        async fetch(request) {
            const url = new URL(request.url)

            if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
                if (request.method === "OPTIONS") {
                    const origin = request.headers.get("origin")
                    if (!origin || !origins.has(origin))
                        return new Response(null, { status: 403 })
                    return new Response(null, {
                        status: 204,
                        headers: {
                            "access-control-allow-origin": origin,
                            "access-control-allow-methods":
                                "GET, POST, PUT, PATCH, DELETE",
                            "access-control-allow-headers": "content-type",
                            "access-control-max-age": "600",
                            vary: "origin",
                        },
                    })
                }
                return withCors(request, await handleApiRequest(request))
            }

            return serveStatic(ui, url)
        },
    })

    if (options.log !== false) {
        console.log(`tasks api  → http://localhost:${server.port}/api`)
        console.log(`repo root  → ${ws.repoRoot}`)
        console.log(`database   → ${ws.dbPath}`)
        console.log(`workspace  → ${ws.tasksDir}`)
        console.log(`web ui     → ${describeUi(ui)}`)
    }
    return server
}

function describeUi(ui: ResolvedUi | null): string {
    if (!ui) return "none (API only)"
    const built = existsSync(join(ui.dir, "index.html")) ? "" : " (not built)"
    return `${ui.source}: ${ui.dir}${built}`
}

function serveStatic(ui: ResolvedUi | null, url: URL): Response {
    const indexPath = ui && join(ui.dir, "index.html")
    if (!ui || !indexPath || !existsSync(indexPath)) {
        return new Response(
            ui
                ? `The ${ui.source} UI at ${ui.dir} has not been built yet.\n\n` +
                      "Run `tasks web` (which builds it first when it knows how), " +
                      "or `tasks web --dev` for a hot-reloading dev server."
                : "This server hosts the API only. See /api.",
            {
                status: ui ? 503 : 404,
                headers: { "content-type": "text/plain; charset=utf-8" },
            },
        )
    }

    // Serve the requested asset when it exists, otherwise fall back to index.html
    // so client-side routes survive a refresh.
    const root = resolve(ui.dir)
    const candidate = resolve(root, `.${decodeURIComponent(url.pathname)}`)
    if (
        candidate.startsWith(root + sep) &&
        url.pathname !== "/" &&
        existsSync(candidate) &&
        statSync(candidate).isFile()
    ) {
        return new Response(Bun.file(candidate))
    }

    return new Response(Bun.file(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
    })
}
