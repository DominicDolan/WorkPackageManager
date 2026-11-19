import {
    addWorkPackageBranch,
    advanceWorkPackage,
    editWorkPackageBranch,
    rebaseWorkPackageBranch,
} from "@work-task-manager/core/delivery"
import { stopRebaseSupervisor } from "@work-task-manager/core/rebaseSupervisor"
import {
    createInvestigation,
    createWorkPackage,
    deleteWorkPackage,
    deleteWorkPackageBranch,
    getInvestigationDetail,
    listTasks,
    listWorkPackageRuns,
    listWorkPackages,
    reorderWorkPackages,
    requireWorkPackage,
    requireWorkPackageBranch,
    resolveWorkPackageBranch,
    updateWorkPackage,
} from "@work-task-manager/core/repo"
import {
    getWorkPackageDetail,
    workPackageBranchDetail,
} from "@work-task-manager/core/workPackageBranch"
import {
    startWorkPackageRun,
    stopWorkPackageRun,
} from "@work-task-manager/core/workPackageRuns"
import {
    deleteWorkRun,
    renameWorkRun,
    requireWorkRun,
    resumeWorkRun,
    setWorkRunSupervisor,
    startWorkRun,
    stopWorkRun,
} from "@work-task-manager/core/workRuns"
import type {
    AgentPermissionMode,
    AgentRunMode,
    WorkRunKind,
} from "@work-task-manager/shared"
import { HttpError, created, fail } from "../http"
import { route, type Context } from "../router"
import {
    branchInput,
    checkPermissionMode,
    intParam,
    parsePipelinePlan,
    requireSupervisor,
    stringList,
    type BranchInput,
    type SupervisorInput,
} from "./parse"

/** The work package a route names, and the run id it names within it. */
function ownedRun({ params }: Context): {
    workPackageRef: string
    runId: number
} {
    const workPackage = requireWorkPackage(params.ref!)
    const runId = intParam(params.id)
    if (requireWorkRun(runId).workPackageRef !== workPackage.ref)
        throw new HttpError(404, `Run ${runId} is not in ${workPackage.ref}.`)
    return { workPackageRef: workPackage.ref, runId }
}

/** The branch a route names, by id or Git name, within its work package. */
function namedBranch({ params }: Context) {
    const workPackage = requireWorkPackage(params.ref!)
    return {
        workPackage,
        branch: resolveWorkPackageBranch(workPackage.ref, params.id!),
    }
}

const detailOf = (ref: string) => ({ workPackage: getWorkPackageDetail(ref) })

export const workPackageRoutes = [
    route(
        "GET",
        "/work-packages",
        "List work packages with their counts.",
        () => ({
            workPackages: listWorkPackages(),
        }),
    ),

    route(
        "POST",
        "/work-packages",
        "Create a work package, optionally with investigations and branches.",
        async ({ body }) => {
            const input = await body<{
                name?: string
                color?: string
                investigations?: { title?: string; brief?: string }[]
                branches?: BranchInput[]
            }>()
            if (!input.name) return fail("A work package needs a name.")
            const workPackage = createWorkPackage({
                name: input.name,
                color: input.color,
                investigations: input.investigations,
                branches: input.branches?.map(branchInput),
            })
            return created({ workPackage, workPackages: listWorkPackages() })
        },
    ),

    route(
        "POST",
        "/work-packages/reorder",
        "Set the order of empty work packages, and how ties are settled.",
        async ({ body }) => {
            const input = await body<{ refs?: unknown }>()
            return {
                workPackages: reorderWorkPackages(
                    stringList(
                        input.refs,
                        "refs must be an array of work package references, in their new order.",
                    ),
                ),
            }
        },
    ),

    // One read for the page, so the branches' live Git state and the work order
    // are consistent with each other.
    route(
        "GET",
        "/work-packages/:ref",
        "One work package: tasks in work order, investigations, branches with live Git state, runs, tabs.",
        ({ params }) => detailOf(params.ref!),
    ),

    route(
        "PATCH",
        "/work-packages/:ref",
        "Rename or recolour a work package.",
        async ({ params, body }) => {
            const input = await body<{ name?: string; color?: string }>()
            updateWorkPackage(params.ref!, {
                name: input.name,
                color: input.color,
            })
            return { workPackages: listWorkPackages(), tasks: listTasks() }
        },
    ),

    // The tasks are kept and turned loose; saying which ones is the whole
    // reassurance a delete confirmation needs.
    route(
        "DELETE",
        "/work-packages/:ref",
        "Delete a work package, releasing its tasks.",
        ({ params }) => {
            const result = deleteWorkPackage(params.ref!)
            return {
                deleted: result.ref,
                released: result.released,
                workPackages: listWorkPackages(),
                tasks: listTasks(),
            }
        },
    ),

    route(
        "POST",
        "/work-packages/:ref/investigations",
        "Write another question down for a work package.",
        async ({ params, body }) => {
            const workPackage = requireWorkPackage(params.ref!)
            const input = await body<{ title?: string; brief?: string }>()
            const investigation = createInvestigation({
                title: input.title?.trim() || workPackage.name,
                brief: input.brief,
                workPackageRef: workPackage.ref,
            })
            return created({
                investigation: getInvestigationDetail(investigation.ref),
                workPackage: getWorkPackageDetail(workPackage.ref),
            })
        },
    ),

    /* ------------------------------------------------------------ run tabs */

    route(
        "POST",
        "/work-packages/:ref/work-runs",
        "Start a run tab: an agent working the package, or a start-to-finish pipeline.",
        async ({ params, body }) => {
            const workPackage = requireWorkPackage(params.ref!)
            const input = await body<{
                kind?: string
                label?: string
                harness?: string
                model?: string
                mode?: string
                permissionMode?: string
                extra?: string
                supervisor?: SupervisorInput | null
                fallback?: string
                machine?: string | null
                plan?: unknown
            }>()
            if (!input.harness) return fail("A harness is required.")
            const supervisor = requireSupervisor(input.supervisor)
            if (
                input.fallback !== undefined &&
                input.fallback !== "stop" &&
                input.fallback !== "codex"
            )
                return fail("fallback must be stop or codex.")
            const plan =
                input.kind === "pipeline"
                    ? parsePipelinePlan(input.plan)
                    : undefined
            if (typeof plan === "string") return fail(plan)
            checkPermissionMode(input.permissionMode)
            const workRun = startWorkRun({
                workPackageRef: workPackage.ref,
                kind: input.kind as WorkRunKind,
                label: input.label,
                harness: input.harness,
                model: input.model ?? "",
                mode: (input.mode ?? "terminal") as AgentRunMode,
                permissionMode: (input.permissionMode ??
                    "manual") as AgentPermissionMode,
                extra: input.extra ?? "",
                supervisor,
                fallback: input.fallback as "stop" | "codex" | undefined,
                machine: input.machine,
                plan,
            })
            return created({
                workRun,
                workPackage: getWorkPackageDetail(workPackage.ref),
            })
        },
    ),

    route(
        "PATCH",
        "/work-packages/:ref/work-runs/:id",
        "Rename a run tab.",
        async (context) => {
            const { workPackageRef, runId } = ownedRun(context)
            const input = await context.body<{ label?: string }>()
            renameWorkRun(runId, input.label ?? "")
            return detailOf(workPackageRef)
        },
    ),

    route(
        "DELETE",
        "/work-packages/:ref/work-runs/:id",
        "Delete a run tab.",
        (context) => {
            const { workPackageRef, runId } = ownedRun(context)
            deleteWorkRun(runId)
            return detailOf(workPackageRef)
        },
    ),

    route(
        "POST",
        "/work-packages/:ref/work-runs/:id/stop",
        "Stop a run tab's agent.",
        (context) => {
            const { workPackageRef, runId } = ownedRun(context)
            stopWorkRun(runId)
            return detailOf(workPackageRef)
        },
    ),

    route(
        "PUT",
        "/work-packages/:ref/work-runs/:id/supervisor",
        "Set or clear a run tab's supervisor.",
        async (context) => {
            const { workPackageRef, runId } = ownedRun(context)
            const input = await context.body<{
                supervisor?: SupervisorInput | null
            }>()
            setWorkRunSupervisor(runId, requireSupervisor(input.supervisor))
            return detailOf(workPackageRef)
        },
    ),

    route(
        "POST",
        "/work-packages/:ref/work-runs/:id/resume",
        "Resume a run tab, optionally with new agent settings.",
        async (context) => {
            const { workPackageRef, runId } = ownedRun(context)
            const payload = await context.request.text()
            let input: unknown
            try {
                input = payload.trim() ? JSON.parse(payload) : undefined
            } catch {
                return fail("Request body must be valid JSON.")
            }
            if (input === undefined) {
                resumeWorkRun(runId)
                return detailOf(workPackageRef)
            }
            if (!input || typeof input !== "object")
                return fail("Resume settings must be an object.")
            const value = input as Record<string, unknown>
            if (value.taskRun === null)
                return fail("The task stage cannot be removed when resuming.")
            const plan = parsePipelinePlan({
                agent: value.agent,
                taskRun: value.taskRun,
                investigations: [],
                branches: [],
            })
            if (typeof plan === "string") return fail(plan)
            if (
                typeof plan.agent.model !== "string" ||
                typeof plan.agent.extra !== "string"
            )
                return fail("Agent model and instructions must be strings.")
            resumeWorkRun(runId, {
                agent: plan.agent,
                taskRun: plan.taskRun ?? undefined,
            })
            return detailOf(workPackageRef)
        },
    ),

    /* ------------------------------------------------------------ branches */

    route(
        "POST",
        "/work-packages/:ref/branches",
        "Add a branch tab; finished tasks it starts with are merged in at once.",
        async ({ params, body }) => {
            const workPackage = requireWorkPackage(params.ref!)
            const input = await body<BranchInput>()
            const result = addWorkPackageBranch({
                ...branchInput(input),
                workPackageRef: workPackage.ref,
            })
            return created({
                ...result,
                workPackage: getWorkPackageDetail(workPackage.ref),
            })
        },
    ),

    route(
        "PATCH",
        "/work-packages/:ref/branches/:id",
        "Edit a branch tab; a new task list merges added tasks in.",
        async (context) => {
            const { workPackage, branch } = namedBranch(context)
            const input = await context.body<
                BranchInput & { taskRefs?: unknown }
            >()
            const taskRefs =
                input.taskRefs === undefined
                    ? undefined
                    : stringList(
                          input.taskRefs,
                          "taskRefs must be an array of task refs.",
                      )
            const result = editWorkPackageBranch(branch.id, {
                label: input.label,
                branchName: input.branchName,
                baseBranch: input.baseBranch,
                taskRefs,
            })
            return {
                ...result,
                workPackage: getWorkPackageDetail(workPackage.ref),
            }
        },
    ),

    route(
        "DELETE",
        "/work-packages/:ref/branches/:id",
        "Remove a branch tab (the Git branch is left alone).",
        (context) => {
            const { workPackage, branch } = namedBranch(context)
            deleteWorkPackageBranch(branch.id)
            return detailOf(workPackage.ref)
        },
    ),

    route(
        "POST",
        "/work-packages/:ref/branches/:id/rebase",
        "Rebase a branch onto its base's tip, with an optional supervisor for conflicts.",
        async (context) => {
            const { workPackage, branch } = namedBranch(context)
            const input = await context.bodyOr<{
                supervisor?: SupervisorInput | null
            }>({})
            const result = rebaseWorkPackageBranch(
                branch,
                requireSupervisor(input.supervisor),
            )
            return {
                ...result,
                workPackage: getWorkPackageDetail(workPackage.ref),
            }
        },
    ),

    route(
        "DELETE",
        "/work-packages/:ref/branches/:id/rebase-supervisor",
        "Stop the supervisor resolving a branch's rebase.",
        (context) => {
            const { branch } = namedBranch(context)
            stopRebaseSupervisor(branch.branchName)
            return {
                branch: workPackageBranchDetail(
                    requireWorkPackageBranch(branch.id),
                ),
            }
        },
    ),

    /* ------------------------------------------------------- whole package */

    route(
        "POST",
        "/work-packages/:ref/advance",
        "Sign a whole work package off: every Dev Complete task to Verified, or on to Closed.",
        async ({ params, body }) => {
            const input = await body<{ status?: unknown }>()
            if (input.status !== "verified" && input.status !== "closed")
                return fail("status must be 'verified' or 'closed'.")
            const result = await advanceWorkPackage(params.ref!, input.status)
            return {
                workPackage: result.workPackage,
                outcomes: result.outcomes,
                workPackages: listWorkPackages(),
                tasks: listTasks(),
            }
        },
    ),

    // A fresh headless agent per task, this server driving the queue between them.
    route(
        "POST",
        "/work-packages/:ref/run",
        "Work the whole package unattended, one headless agent per task.",
        async ({ params, body }) => {
            const ref = params.ref!
            const input = await body<{
                harness?: string
                model?: string
                permissionMode?: string
                extra?: string
                excluded?: unknown
                machine?: string | null
            }>()
            if (!input.harness) return fail("A harness is required.")
            const excluded =
                input.excluded === undefined
                    ? []
                    : stringList(
                          input.excluded,
                          "excluded must be an array of task refs.",
                      )
            checkPermissionMode(input.permissionMode)
            const started = startWorkPackageRun({
                workPackageRef: ref,
                harness: input.harness,
                model: input.model ?? "",
                // Nobody is watching any of these runs, so the only mode that can finish
                // is the one that never asks. Overridable, but not by omission.
                permissionMode:
                    (input.permissionMode as AgentPermissionMode | undefined) ??
                    "bypassPermissions",
                extra: input.extra ?? "",
                excluded,
                machine: input.machine,
            })
            return created({
                workPackageRun: started.workPackageRun,
                run: started.run,
                workPackage: getWorkPackageDetail(ref),
            })
        },
    ),

    // Stopping kills the agent in flight; the tasks already merged stay merged.
    route(
        "DELETE",
        "/work-packages/:ref/run",
        "Stop the unattended run.",
        ({ params }) => {
            const ref = params.ref!
            const workPackage = getWorkPackageDetail(ref)
            if (!workPackage.run) return fail(`${ref} has no run to stop.`)
            return {
                workPackageRun: stopWorkPackageRun(workPackage.run.id),
                workPackage: getWorkPackageDetail(ref),
            }
        },
    ),

    route(
        "GET",
        "/work-packages/:ref/runs",
        "What the work package has been run through before.",
        ({ params }) => ({
            runs: listWorkPackageRuns(params.ref!),
        }),
    ),
]
