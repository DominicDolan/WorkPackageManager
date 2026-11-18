import {
    issueFacets,
    listIssuesWithBodies,
    readIssue,
} from "@work-task-manager/core/issues"
import { notesWorkspaceInfo } from "@work-task-manager/core/notes"
import { fail } from "../http"
import { route } from "../router"

/**
 * Read-only, and re-read per request. The files are fetched by something else
 * and can be replaced at any moment, so there is nothing to cache.
 */
export const issueRoutes = [
    route(
        "GET",
        "/issues",
        "Issues from the notes folder, filtered by state, source, label or q, with facets.",
        ({ query }) => {
            const state = query.get("state") ?? undefined
            if (
                state &&
                state !== "open" &&
                state !== "closed" &&
                state !== "all"
            )
                return fail("state must be 'open', 'closed' or 'all'.")
            return {
                issues: listIssuesWithBodies({
                    state: state as "open" | "closed" | "all" | undefined,
                    source: query.get("source") ?? undefined,
                    label: query.get("label") ?? undefined,
                    search: query.get("q") ?? undefined,
                }),
                facets: issueFacets(),
                notes: notesWorkspaceInfo(),
            }
        },
    ),
    route("GET", "/issues/:id", "One issue.", ({ params }) => ({
        issue: readIssue(params.id!),
    })),
]
