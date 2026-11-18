import {
    addTranscriptLink,
    listTranscripts,
    readTranscript,
    removeTranscriptLink,
} from "@work-task-manager/core/transcripts"
import { fail } from "../http"
import { route, type Context } from "../router"

async function link(context: Context, add: boolean) {
    const input = await context.body<{
        kind?: "task" | "investigation"
        ref?: string
    }>()
    if (!input.kind || !input.ref?.trim())
        return fail("Choose a task or investigation.")
    const change = add ? addTranscriptLink : removeTranscriptLink
    return {
        transcript: change(context.params.path!, input.kind, input.ref.trim()),
    }
}

/** Synced agent transcripts. A path contains slashes, so it is one encoded segment. */
export const transcriptRoutes = [
    route("GET", "/transcripts", "Every synced transcript.", () => ({
        transcripts: listTranscripts(),
    })),
    route(
        "GET",
        "/transcripts/:path",
        "One transcript and what it is linked to.",
        ({ params }) => ({
            transcript: readTranscript(params.path!),
        }),
    ),
    route(
        "POST",
        "/transcripts/:path/links",
        "Link a transcript to a task or investigation.",
        (context) => link(context, true),
    ),
    route(
        "DELETE",
        "/transcripts/:path/links",
        "Unlink a transcript from a task or investigation.",
        (context) => link(context, false),
    ),
]
