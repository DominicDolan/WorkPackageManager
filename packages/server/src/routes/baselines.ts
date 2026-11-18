import {
    approveBaseline,
    readBaselines,
    runBaselines,
} from "@work-task-manager/core/baselines"
import { fail } from "../http"
import { route } from "../router"

export const baselineRoutes = [
    route(
        "GET",
        "/baselines",
        "The last baseline run, joined with what has been approved.",
        async () => ({
            report: await readBaselines(),
        }),
    ),

    // A non-zero exit means "something drifted", which is a result rather than
    // a failure, so it rides along with the report instead of becoming a 500.
    route(
        "POST",
        "/baselines/run",
        "Re-run the baseline scenarios, optionally only the named ones.",
        async ({ bodyOr }) => {
            const input = await bodyOr<{ scenarios?: unknown }>({})
            if (
                input.scenarios !== undefined &&
                (!Array.isArray(input.scenarios) ||
                    input.scenarios.some((one) => typeof one !== "string"))
            )
                return fail("scenarios must be an array of scenario names.")
            return runBaselines((input.scenarios as string[] | undefined) ?? [])
        },
    ),

    route(
        "POST",
        "/baselines/approve",
        "Promote one scenario's capture to its baseline.",
        async ({ body }) => {
            const input = await body<{ scenario?: unknown }>()
            if (typeof input.scenario !== "string" || !input.scenario.trim())
                return fail("A scenario name is required.")
            return { report: await approveBaseline(input.scenario) }
        },
    ),
]
