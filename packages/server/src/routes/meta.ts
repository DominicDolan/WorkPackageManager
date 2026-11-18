import { existsSync } from "node:fs"
import { aioVrAvailable } from "@work-task-manager/core/aiovr"
import { toolAvailability } from "@work-task-manager/core/branches"
import {
    lazyWorkspace,
    resolveArtifact,
} from "@work-task-manager/core/config/paths"
import { notesWorkspaceInfo } from "@work-task-manager/core/notes"
import {
    readConfigContent,
    writeConfigContent,
} from "@work-task-manager/core/workspaceConfig"
import {
    INVESTIGATION_STATUSES,
    INVESTIGATION_STATUS_LABELS,
    PRIORITIES,
    STATUSES,
    STATUS_LABELS,
} from "@work-task-manager/shared"
import { fail, file } from "../http"
import { route } from "../router"
import { eventStream } from "./events"

const ws = lazyWorkspace()

/**
 * Bumped when a response shape or route changes incompatibly, so a repository's
 * own UI, built against an older `@work-task-manager/client`, can say so
 * plainly instead of failing on a missing field.
 */
export const API_VERSION = 1

export const metaRoutes = [
    // Enough for a client to confirm it found this server and which contract it
    // speaks, before it makes any real request.
    route("GET", "/", "Server name, API version and repository root.", () => ({
        name: "work-task-manager",
        apiVersion: API_VERSION,
        repoRoot: ws.repoRoot,
    })),

    route(
        "GET",
        "/meta",
        "Vocabularies (statuses, priorities, labels) and which tools and folders are available.",
        async () => ({
            statuses: STATUSES,
            priorities: PRIORITIES,
            statusLabels: STATUS_LABELS,
            investigationStatuses: INVESTIGATION_STATUSES,
            investigationStatusLabels: INVESTIGATION_STATUS_LABELS,
            repoRoot: ws.repoRoot,
            aioVrDir: ws.aioVrDir,
            aioVrInstalled: aioVrAvailable(),
            aioVrWorkspaceExists: existsSync(ws.aioVrDir),
            notes: notesWorkspaceInfo(),
            tools: await toolAvailability(),
        }),
    ),

    route(
        "GET",
        "/events",
        "Server-sent events: `hello` with revisions, then `change` {channel, revision} on every write.",
        ({ request }) => eventStream(request),
    ),

    route(
        "GET",
        "/config",
        "The repository's tasks.config.json, as text.",
        () => ({ content: readConfigContent() }),
    ),

    route(
        "PUT",
        "/config",
        "Replace tasks.config.json (validated first, applied at once).",
        async ({ body }) => {
            const input = await body<{ content?: string }>()
            if (typeof input.content !== "string")
                return fail("Config content must be a string.")
            return { content: writeConfigContent(input.content) }
        },
    ),

    // Screenshots are streamed from disk rather than copied into the database.
    // Checkpoint artefacts are rewritten in place by each `after` run, so they
    // must never be cached.
    route(
        "GET",
        "/image",
        "Stream a checkpoint screenshot from the aio-vr workspace (?path=).",
        ({ query }) => {
            const relativePath = query.get("path")
            if (!relativePath) return fail("An image path is required.")
            const absolute = resolveArtifact(relativePath)
            if (!absolute)
                return fail("No such image inside the aio-vr workspace.", 404)
            return file(absolute, "no-store")
        },
    ),
]
