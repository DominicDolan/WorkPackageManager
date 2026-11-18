import {
    createInvestigation,
    deleteInvestigation,
    getInvestigationDetail,
    isInvestigationStatus,
    listInvestigations,
    setInvestigationStatus,
    updateInvestigation,
} from "@work-task-manager/core/repo"
import {
    INVESTIGATION_STATUSES,
    type InvestigationStatus,
} from "@work-task-manager/shared"
import { created, fail } from "../http"
import { route } from "../router"

export const investigationRoutes = [
    route(
        "GET",
        "/investigations",
        "List investigations, optionally by status.",
        ({ query }) => {
            const status = query.get("status") ?? undefined
            if (status && !isInvestigationStatus(status))
                return fail(`Unknown investigation status '${status}'.`)
            return {
                investigations: listInvestigations({
                    status: status as InvestigationStatus | undefined,
                }),
            }
        },
    ),

    route(
        "POST",
        "/investigations",
        "Write a question down.",
        async ({ body }) => {
            const input = await body<{
                title?: string
                brief?: string
                workPackageRef?: string
            }>()
            if (!input.title) return fail("An investigation needs a title.")
            const { ref } = createInvestigation({
                title: input.title,
                brief: input.brief,
                workPackageRef: input.workPackageRef,
            })
            return created({ investigation: getInvestigationDetail(ref) })
        },
    ),

    route(
        "GET",
        "/investigations/:ref",
        "One investigation with the tasks it filed.",
        ({ params }) => ({
            investigation: getInvestigationDetail(params.ref!),
        }),
    ),

    route(
        "PATCH",
        "/investigations/:ref",
        "Edit an investigation's title, brief or findings.",
        async ({ params, body }) => {
            updateInvestigation(
                params.ref!,
                await body<{
                    title?: string
                    brief?: string
                    findings?: string
                }>(),
            )
            return { investigation: getInvestigationDetail(params.ref!) }
        },
    ),

    route(
        "DELETE",
        "/investigations/:ref",
        "Delete an investigation (its tasks are kept).",
        ({ params }) => {
            deleteInvestigation(params.ref!)
            return { deleted: params.ref }
        },
    ),

    route(
        "POST",
        "/investigations/:ref/status",
        "Set an investigation's status.",
        async ({ params, body }) => {
            const input = await body<{ status?: string }>()
            if (!input.status || !isInvestigationStatus(input.status))
                return fail(
                    `status must be one of: ${INVESTIGATION_STATUSES.join(", ")}.`,
                )
            setInvestigationStatus(params.ref!, input.status)
            return { investigation: getInvestigationDetail(params.ref!) }
        },
    ),
]
