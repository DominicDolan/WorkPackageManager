import { captureAfter, captureBefore } from "@work-task-manager/core/aiovr"
import {
    addTaskAttachment,
    removeTaskAttachment,
    resolveTaskAsset,
} from "@work-task-manager/core/attachments"
import {
    closeTask,
    combineTasks,
    continueCombine,
    mergeIntoTargetBranches,
    previewCombine,
    setTaskStatus,
} from "@work-task-manager/core/delivery"
import {
    addDependency,
    addNote,
    createTask,
    deleteTask,
    getTaskDetail,
    isModelTier,
    isPriority,
    isStatus,
    listTasks,
    listWorkPackages,
    moveTask,
    removeDependency,
    reorderTasks,
    requireTask,
    setWorkPackage,
    updateTask,
    updateTaskBranchName,
} from "@work-task-manager/core/repo"
import {
    captureBeforeRetro,
    resolveRetroTarget,
} from "@work-task-manager/core/retro"
import { syncTaskVisuals } from "@work-task-manager/core/visualSync"
import { announceChange } from "@work-task-manager/core/watch"
import { STATUSES, type Status } from "@work-task-manager/shared"
import { HttpError, created, fail, file } from "../http"
import { route, type Context } from "../router"
import {
    parseRefs,
    parseTags,
    parseUnits,
    stringList,
    uploadedFiles,
} from "./parse"

interface TaskFields {
    title?: string
    description?: string
    priority?: string
    recommendedTier?: string | null
    tags?: unknown
    useGitWorkflow?: boolean
    useVisualRegression?: boolean
    branchName?: string
    investigationRef?: string | null
    workPackageRef?: string | null
    dependsOn?: unknown
    estimateUnits?: unknown
}

/** The checks a create and an edit share. */
function checkTaskFields(input: TaskFields): void {
    if (input.priority && !isPriority(input.priority))
        throw new HttpError(400, `Unknown priority '${input.priority}'.`)
    if (input.recommendedTier && !isModelTier(input.recommendedTier))
        throw new HttpError(400, `Unknown tier '${input.recommendedTier}'.`)
    if (
        input.useGitWorkflow !== undefined &&
        typeof input.useGitWorkflow !== "boolean"
    )
        throw new HttpError(400, "useGitWorkflow must be a boolean.")
    if (
        input.useVisualRegression !== undefined &&
        typeof input.useVisualRegression !== "boolean"
    )
        throw new HttpError(400, "useVisualRegression must be a boolean.")
}

async function checkpoint({ params, bodyOr }: Context) {
    const { ref, phase } = params as { ref: string; phase: string }
    if (phase === "sync") {
        const sync = syncTaskVisuals(ref)
        announceChange("notes")
        return { sync }
    }
    if (phase !== "before" && phase !== "after")
        return fail("Checkpoint action must be 'before', 'after' or 'sync'.")

    const input = await bodyOr<{
        scenarios?: string[]
        folders?: string[]
        minPercent?: number
        allowMissing?: boolean
        retro?: boolean
        at?: string
        settleSeconds?: number
    }>({})

    const task = requireTask(ref)
    const options = {
        scenarios: input.scenarios,
        folders: input.folders,
        minPercent: input.minPercent,
        allowMissing: input.allowMissing,
        inheritStdio: false,
    }

    // A retroactive before moves the working tree to an older commit and back.
    // It is only offered for 'before': there is no sense in which 'after' could
    // be captured anywhere but where the work now stands.
    if (phase === "before" && (input.retro || input.at)) {
        const target = resolveRetroTarget(task, input.at)
        const retro = await captureBeforeRetro(task, target, {
            ...options,
            settleSeconds: input.settleSeconds,
        })
        return {
            run: retro,
            target: retro.target,
            restoredTo: retro.restoredTo,
            task: getTaskDetail(ref),
        }
    }

    const run =
        phase === "before"
            ? await captureBefore(task, options)
            : await captureAfter(task, options)
    return { run, task: getTaskDetail(ref) }
}

export const taskRoutes = [
    route(
        "GET",
        "/tasks",
        "List tasks, filtered by status, tag, investigation or work package.",
        ({ query }) => {
            const status = query.get("status") ?? undefined
            if (status && !isStatus(status))
                return fail(`Unknown status '${status}'.`)
            return {
                tasks: listTasks({
                    status: status as Status | undefined,
                    tag: query.get("tag") ?? undefined,
                    investigationRef: query.get("investigation") ?? undefined,
                    workPackageRef: query.get("work-package") ?? undefined,
                }),
            }
        },
    ),

    route("POST", "/tasks", "Create a task.", async ({ body }) => {
        const input = await body<TaskFields>()
        if (!input.title) return fail("A task needs a title.")
        checkTaskFields(input)
        return created({
            task: createTask({
                title: input.title,
                description: input.description,
                priority: input.priority as never,
                recommendedTier: input.recommendedTier as never,
                tags: parseTags(input.tags),
                useGitWorkflow: input.useGitWorkflow,
                useVisualRegression: input.useVisualRegression,
                branchName: input.branchName,
                investigationRef: input.investigationRef as string | undefined,
                workPackageRef: input.workPackageRef,
                dependsOn: parseRefs(input.dependsOn, "dependsOn"),
                estimateUnits: parseUnits(input.estimateUnits),
            }),
        })
    }),

    route(
        "POST",
        "/tasks/reorder",
        "Reorder the queue: the whole list, or just the rows a filtered view shows.",
        async ({ body }) => {
            const input = await body<{ refs?: unknown }>()
            reorderTasks(
                stringList(
                    input.refs,
                    "refs must be an array of task references, in their new order.",
                ),
            )
            return { tasks: listTasks() }
        },
    ),

    route(
        "POST",
        "/tasks/combine/preview",
        "Show what combining tasks onto one branch would pick, without doing it.",
        async ({ body }) => {
            const input = await body<{ refs?: unknown }>()
            return previewCombine(
                stringList(
                    input.refs,
                    "refs must be an array of task references.",
                ),
            )
        },
    ),

    route(
        "POST",
        "/tasks/combine/continue",
        "Carry on a combine paused on a conflict.",
        async ({ body }) => {
            const input = await body<{ branchName?: unknown }>()
            if (typeof input.branchName !== "string")
                return fail("A branch name is required.")
            return continueCombine(input.branchName)
        },
    ),

    route(
        "POST",
        "/tasks/combine",
        "Cherry-pick tasks' branches, in order, onto one new delivery branch.",
        async ({ body }) => {
            const input = await body<{
                refs?: unknown
                branchName?: unknown
                closeTasks?: unknown
            }>()
            const refs = stringList(
                input.refs,
                "refs must be an array of task references.",
            )
            if (typeof input.branchName !== "string")
                return fail("A branch name is required.")
            if (
                input.closeTasks !== undefined &&
                typeof input.closeTasks !== "boolean"
            )
                return fail("closeTasks must be a boolean.")
            const result = await combineTasks(
                refs,
                input.branchName,
                input.closeTasks ?? true,
            )
            return created({
                branchName: result.branchName,
                tasks: result.tasks,
                conflicted: result.conflicted,
                base: result.base,
            })
        },
    ),

    route(
        "GET",
        "/tasks/asset",
        "Stream a file attached to a task (?ref=&name=).",
        ({ query }) => {
            const ref = query.get("ref")
            const name = query.get("name")
            if (!ref || !name)
                return fail("A task ref and attachment name are required.")
            const absolute = resolveTaskAsset(ref, name)
            if (!absolute) return fail("No such attachment on that task.", 404)
            // Attachments are immutable once written — a re-upload gets a new name.
            return file(absolute, "private, max-age=300")
        },
    ),

    route(
        "GET",
        "/tasks/:ref",
        "One task with its history, checkpoints and attachments.",
        ({ params }) => ({
            task: getTaskDetail(params.ref!),
        }),
    ),

    route(
        "PATCH",
        "/tasks/:ref",
        "Edit a task's fields.",
        async ({ params, body }) => {
            const ref = params.ref!
            const input = await body<TaskFields>()
            checkTaskFields(input)
            if (
                input.useGitWorkflow === false &&
                input.branchName !== undefined
            )
                return fail(
                    "A task cannot have a branch when its Git workflow is disabled.",
                )
            if (input.branchName !== undefined)
                updateTaskBranchName(ref, input.branchName)
            updateTask(ref, {
                title: input.title,
                description: input.description,
                priority: input.priority as never,
                recommendedTier: input.recommendedTier as never,
                tags: parseTags(input.tags),
                useGitWorkflow: input.useGitWorkflow,
                useVisualRegression: input.useVisualRegression,
                investigationRef: input.investigationRef,
                workPackageRef: input.workPackageRef,
                dependsOn: parseRefs(input.dependsOn, "dependsOn"),
                estimateUnits: parseUnits(input.estimateUnits),
            })
            return { task: getTaskDetail(ref) }
        },
    ),

    route("DELETE", "/tasks/:ref", "Delete a task.", ({ params }) => {
        deleteTask(params.ref!)
        return { deleted: params.ref }
    }),

    route(
        "POST",
        "/tasks/:ref/close",
        "Clean a Verified task's checkpoint and close it.",
        async ({ params }) => ({
            task: await closeTask(params.ref!),
        }),
    ),

    route(
        "POST",
        "/tasks/:ref/dependencies",
        "Add blockers to a task.",
        async ({ params, body }) => {
            const input = await body<{ dependsOn?: unknown }>()
            const refs = parseRefs(input.dependsOn, "dependsOn")
            if (!refs?.length)
                return fail("dependsOn must name at least one task.")
            for (const blocker of refs) addDependency(params.ref!, blocker)
            return { task: getTaskDetail(params.ref!) }
        },
    ),

    route(
        "DELETE",
        "/tasks/:ref/dependencies/:blocker",
        "Remove one blocker from a task.",
        ({ params }) => ({
            task: getTaskDetail(
                removeDependency(params.ref!, params.blocker!).ref,
            ),
        }),
    ),

    route(
        "POST",
        "/tasks/:ref/attachments",
        "Upload files to a task (multipart, field `file`).",
        async ({ params, request }) => {
            const ref = params.ref!
            const added = []
            for (const one of await uploadedFiles(request))
                added.push(
                    addTaskAttachment(
                        ref,
                        one.name || "attachment",
                        await one.arrayBuffer(),
                    ),
                )
            return created({ added, task: getTaskDetail(ref) })
        },
    ),

    route(
        "DELETE",
        "/tasks/:ref/attachments/:name",
        "Remove one attachment from a task.",
        ({ params }) => {
            removeTaskAttachment(params.ref!, params.name!)
            return { task: getTaskDetail(params.ref!) }
        },
    ),

    route(
        "POST",
        "/tasks/:ref/status",
        "Move a task to a status; dev complete merges it into its target branches.",
        async ({ params, body }) => {
            const input = await body<{
                status?: string
                note?: string
                merge?: boolean
            }>()
            if (!input.status || !isStatus(input.status))
                return fail(`status must be one of: ${STATUSES.join(", ")}.`)
            return setTaskStatus(
                params.ref!,
                input.status,
                input.note,
                input.merge !== false,
            )
        },
    ),

    route(
        "POST",
        "/tasks/:ref/merge",
        "Merge a task into its target branches, after a conflict was resolved or a merge skipped.",
        ({ params }) => {
            const mergeError = mergeIntoTargetBranches(params.ref!)
            if (mergeError) return fail(mergeError)
            return { task: getTaskDetail(params.ref!), mergeError: null }
        },
    ),

    route(
        "POST",
        "/tasks/:ref/notes",
        "Add a note to a task's history.",
        async ({ params, body }) => {
            const input = await body<{ note?: string }>()
            if (!input.note) return fail("A note is required.")
            addNote(params.ref!, input.note)
            return { task: getTaskDetail(params.ref!) }
        },
    ),

    // One gesture with two effects: the row changes work package *and* lands
    // somewhere. `reposition: false` leaves the queue alone for a caller that is
    // about to reorder it itself, which is exactly what a drag does.
    route(
        "POST",
        "/tasks/:ref/work-package",
        "Move a task into a work package (or out, with null).",
        async ({ params, body }) => {
            const ref = params.ref!
            const input = await body<{
                workPackageRef?: unknown
                reposition?: unknown
            }>()
            if (
                input.workPackageRef !== null &&
                typeof input.workPackageRef !== "string"
            )
                return fail(
                    "workPackageRef must be a work package reference, or null to remove the task from its work package.",
                )
            if (
                input.reposition !== undefined &&
                typeof input.reposition !== "boolean"
            )
                return fail("reposition must be a boolean.")
            setWorkPackage(ref, input.workPackageRef, {
                reposition: input.reposition,
            })
            return {
                task: getTaskDetail(ref),
                tasks: listTasks(),
                workPackages: listWorkPackages(),
            }
        },
    ),

    route(
        "POST",
        "/tasks/:ref/move",
        "Move a task within its list: top, bottom, up, down, or before/after another.",
        async ({ params, body }) => {
            const input = await body<{ to?: string; ref?: string }>()
            const to = input.to
            if (to === "top" || to === "bottom" || to === "up" || to === "down")
                return { tasks: moveTask(params.ref!, { to }) }
            if (to === "before" || to === "after") {
                if (!input.ref)
                    return fail(`Moving '${to}' needs the ref to move ${to}.`)
                return { tasks: moveTask(params.ref!, { to, ref: input.ref }) }
            }
            return fail(
                "to must be one of: top, bottom, up, down, before, after.",
            )
        },
    ),

    route(
        "POST",
        "/tasks/:ref/checkpoint/:phase",
        "Capture a visual checkpoint (before, after) or sync its evidence to notes (sync).",
        checkpoint,
    ),
]
