import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Workspace } from "@work-task-manager/core/config/paths"

/**
 * Which static UI the server hosts, and where it came from.
 *
 * In order: an explicit directory (`TASKS_WEB_DIST`, or the caller's own
 * choice), the repository's `ui` setting in `tasks.config.json`, then the
 * default UI. The repository's setting wins over the default because a repo
 * that configured its own UI wants it every time.
 */
export interface ResolvedUi {
    /** Directory holding `index.html` (or expected to, once built). */
    dir: string
    source: "explicit" | "repository" | "default"
    /** How to produce `dir` when it is not built yet, if anyone said. */
    build: { command: string[]; cwd: string } | null
    /** How to start a hot-reloading dev server for it, if anyone said. */
    dev: { command: string[]; cwd: string } | null
}

/**
 * The default UI's directory and how to build/serve it, or null when it is not
 * installed.
 *
 * This package does not depend on the default UI (an API-only deployment needs
 * no Solid app), so the caller says where to resolve `@work-task-manager/web`
 * from (`resolveFrom`), and where a prebuilt copy might sit (`bundled`, which
 * is how a published CLI ships it).
 */
export function defaultUi(
    resolveFrom: string[] = [],
    bundled: string[] = [],
): ResolvedUi | null {
    for (const dir of bundled) {
        if (existsSync(join(dir, "index.html")))
            return { dir, source: "default", build: null, dev: null }
    }
    let webRoot: string | null = null
    for (const from of [...resolveFrom, import.meta.dir]) {
        try {
            webRoot = dirname(
                Bun.resolveSync("@work-task-manager/web/package.json", from),
            )
            break
        } catch {
            // Not visible from here; try the next place.
        }
    }
    if (!webRoot) return null
    const hasVite = existsSync(join(webRoot, "vite.config.ts"))
    return {
        dir: join(webRoot, "dist"),
        source: "default",
        build: hasVite
            ? { command: ["bunx", "vite", "build"], cwd: webRoot }
            : null,
        dev: hasVite ? { command: ["bunx", "vite"], cwd: webRoot } : null,
    }
}

export interface ResolveUiOptions {
    /** Serve this directory and ignore everything else. */
    dir?: string
    /** Ignore the repository's `ui` setting and serve the default UI. */
    useDefault?: boolean
    /** Directories to resolve `@work-task-manager/web` from. */
    resolveDefaultFrom?: string[]
    /** Extra places to look for a prebuilt default UI. */
    bundledDefault?: string[]
}

export function resolveUi(
    ws: Workspace,
    options: ResolveUiOptions = {},
): ResolvedUi | null {
    const explicit = options.dir ?? process.env.TASKS_WEB_DIST
    if (explicit) {
        // `tasks web` has already chosen, and says what it chose so the log is honest.
        const said = process.env.TASKS_WEB_SOURCE
        const source =
            !options.dir && (said === "repository" || said === "default")
                ? said
                : "explicit"
        return { dir: resolve(explicit), source, build: null, dev: null }
    }

    const configured = ws.config.ui
    if (configured && !options.useDefault) {
        const cwd = resolve(ws.repoRoot, configured.cwd ?? ".")
        return {
            dir: resolve(ws.repoRoot, configured.dist),
            source: "repository",
            build: configured.build ? { command: configured.build, cwd } : null,
            dev: configured.dev ? { command: configured.dev, cwd } : null,
        }
    }

    return defaultUi(options.resolveDefaultFrom, options.bundledDefault)
}
