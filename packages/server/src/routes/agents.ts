import {
    agentEnvironment,
    conflictBrief,
    getRun,
    harnessModels,
    listRuns,
    resumeRun,
    startRun,
    stopRun,
} from "@work-task-manager/core/agents"
import { lazyWorkspace } from "@work-task-manager/core/config/paths"
import {
    AGENT_COMMANDS,
    AGENT_RUN_MODES,
    type AgentCommand,
    type AgentPermissionMode,
    type AgentRunMode,
    type GitConflict,
} from "@work-task-manager/shared"
import { created, fail } from "../http"
import { route } from "../router"
import { checkPermissionMode, intParam, parseConflict } from "./parse"

const ws = lazyWorkspace()

/**
 * Launching an agent, and watching one that was launched.
 *
 * The client sends the *intent* (which command, against what, with what extra
 * prompt) and never the argv. Building the command line here is what keeps a
 * browser from being able to ask this server to run anything it likes.
 */
export const agentRoutes = [
    route(
        "GET",
        "/agents",
        "Which harnesses exist, their models, and whether a terminal window can be opened.",
        () => agentEnvironment(),
    ),

    route(
        "GET",
        "/agents/models",
        "One harness's model list (?harness=), for harnesses whose list is slow to read.",
        ({ query }) => {
            const which = query.get("harness")
            if (!which) return fail("A harness is required.")
            return { models: harnessModels(which) }
        },
    ),

    route(
        "POST",
        "/agents/run",
        "Start an agent on a command (work-task, plan-tasks, resolve-conflicts, …).",
        async ({ body }) => {
            const input = await body<{
                harness?: string
                model?: string
                mode?: string
                command?: string
                target?: string
                extra?: string
                subjectKind?: string
                subjectRef?: string
                permissionMode?: string
                conflict?: unknown
            }>()
            if (!input.harness) return fail("A harness is required.")
            let conflict: GitConflict | null = null
            if (input.command === "resolve-conflicts") {
                conflict = parseConflict(input.conflict)
                if (!conflict)
                    return fail("resolve-conflicts needs the conflict report.")
            }
            if (
                !input.command ||
                !AGENT_COMMANDS.includes(input.command as AgentCommand)
            )
                return fail(
                    `command must be one of: ${AGENT_COMMANDS.join(", ")}.`,
                )
            if (
                !input.mode ||
                !AGENT_RUN_MODES.includes(input.mode as AgentRunMode)
            )
                return fail(
                    `mode must be one of: ${AGENT_RUN_MODES.join(", ")}.`,
                )
            checkPermissionMode(input.permissionMode)
            return created({
                run: startRun({
                    harness: input.harness,
                    model: input.model ?? "",
                    mode: input.mode as AgentRunMode,
                    command: input.command as AgentCommand,
                    target: conflict?.branch ?? input.target ?? "",
                    extra: conflict
                        ? conflictBrief(conflict, input.extra ?? "")
                        : (input.extra ?? ""),
                    subjectKind: input.subjectKind ?? "other",
                    subjectRef: input.subjectRef ?? "",
                    // Where the conflict is decides where the agent works: the notes
                    // folder is a repository of its own, beside this one.
                    cwd: conflict?.scope === "notes" ? ws.notesDir : undefined,
                    // A headless run has nobody to answer a prompt, so it defaults to the
                    // only mode that never asks; an interactive one keeps the harness default.
                    permissionMode:
                        (input.permissionMode as
                            AgentPermissionMode | undefined) ??
                        (input.mode === "print"
                            ? "bypassPermissions"
                            : "manual"),
                }),
            })
        },
    ),

    route(
        "GET",
        "/agents/runs",
        "Agent runs, optionally for one subject (?kind=&ref=).",
        ({ query }) => ({
            runs: listRuns({
                subjectKind: query.get("kind") ?? undefined,
                subjectRef: query.get("ref") ?? undefined,
            }),
        }),
    ),

    route(
        "GET",
        "/agents/runs/:id",
        "One run plus the tail of its log.",
        async ({ params }) => ({
            run: await getRun(intParam(params.id)),
        }),
    ),

    route("POST", "/agents/runs/:id/stop", "Stop a run.", ({ params }) => ({
        run: stopRun(intParam(params.id)),
    })),

    route(
        "POST",
        "/agents/runs/:id/resume",
        "Reopen a run's conversation in a terminal.",
        ({ params }) => ({
            run: resumeRun(intParam(params.id)),
        }),
    ),
]
