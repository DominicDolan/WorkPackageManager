import {
    getDb,
    nextWorkPackageRef,
    nextInvestigationRef,
    nextRef,
    nowIso,
} from "./db"
import { workspace } from "../config/paths"
import { branchExists, renameBranch } from "./branches"
import { deleteTaskAttachments, listTaskAttachments } from "./attachments"
import {
    branchNameFor,
    workPackageBranchNameFor,
    checkpointNameFor,
    DEFAULT_ESTIMATE_UNITS,
    INVESTIGATION_STATUSES,
    isWorkPackageColor,
    MODEL_TIERS,
    nextWorkPackageColor,
    parseEstimateUnits,
    PRIORITIES,
    STATUSES,
    type CheckpointRun,
    type ChecksReport,
    type CombinedBranch,
    type Comparison,
    type Investigation,
    type InvestigationDetail,
    type InvestigationStatus,
    type ModelTier,
    type Phase,
    type Priority,
    type Status,
    type AgentHarnessId,
    type AgentPermissionMode,
    type WorkPackageRun,
    type RunSupervisor,
    type WorkPackageRunStatus,
    type Task,
    type TaskDetail,
    type TaskEvent,
    type WorkPackage,
    type WorkPackageBranch,
    type WorkPackageSummary,
} from "../shared/types"

/* ------------------------------------------------------------------ rows */

interface TaskRow {
    id: number
    ref: string
    title: string
    description: string
    status: string
    priority: string
    position: number
    tags: string
    estimate_units: number
    recommended_tier: string | null
    investigation_ref: string | null
    work_package_ref: string | null
    use_git_workflow: number
    branch_name: string | null
    checkpoint_name: string | null
    created_at: string
    updated_at: string
    started_at: string | null
    dev_completed_at: string | null
    verified_at: string | null
    closed_at: string | null
}

/**
 * Every dependency edge, as two lookups keyed by ref.
 *
 * Read whole rather than per task: the edge table is one row per dependency
 * across the entire workspace, so one query costs less than a correlated
 * subquery per row and gives both directions at once. Ordered by the blocking
 * task's list position so a task's blockers read in queue order.
 */
interface DependencyIndex {
    dependsOn: Map<string, string[]>
    blocks: Map<string, string[]>
    /** Lower-cased task ref → the Git names of its target branches, first first. */
    targets: Map<string, string[]>
}

function dependencyIndex(): DependencyIndex {
    const rows = getDb()
        .query<{ task_ref: string; blocker_ref: string }, []>(
            `SELECT t.ref AS task_ref, b.ref AS blocker_ref
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id
         JOIN tasks b ON b.id = d.depends_on_id
        ORDER BY b.position ASC, b.id DESC`,
        )
        .all()

    const index: DependencyIndex = {
        dependsOn: new Map(),
        blocks: new Map(),
        targets: new Map(),
    }
    for (const row of rows) {
        const forward = index.dependsOn.get(row.task_ref)
        if (forward) forward.push(row.blocker_ref)
        else index.dependsOn.set(row.task_ref, [row.blocker_ref])

        const reverse = index.blocks.get(row.blocker_ref)
        if (reverse) reverse.push(row.task_ref)
        else index.blocks.set(row.blocker_ref, [row.task_ref])
    }

    // Branch assignments ride along: they are just as small, and just as often
    // wanted for a whole list at once.
    const assignments = getDb()
        .query<{ task_ref: string; branch_name: string }, []>(
            `SELECT a.task_ref AS task_ref, b.branch_name AS branch_name
         FROM branch_tasks a
         JOIN work_package_branches b ON b.id = a.branch_id
        ORDER BY a.id ASC`,
        )
        .all()
    for (const row of assignments) {
        const key = row.task_ref.toLowerCase()
        const list = index.targets.get(key)
        if (list) list.push(row.branch_name)
        else index.targets.set(key, [row.branch_name])
    }
    return index
}

function toTask(
    row: TaskRow,
    edges: DependencyIndex = dependencyIndex(),
): Task {
    return {
        id: row.id,
        ref: row.ref,
        title: row.title,
        description: row.description,
        status: row.status as Status,
        priority: row.priority as Priority,
        position: row.position,
        tags: JSON.parse(row.tags) as string[],
        estimateUnits: row.estimate_units,
        recommendedTier: row.recommended_tier as ModelTier | null,
        dependsOn: edges.dependsOn.get(row.ref) ?? [],
        blocks: edges.blocks.get(row.ref) ?? [],
        investigationRef: row.investigation_ref,
        workPackageRef: row.work_package_ref,
        useGitWorkflow: row.use_git_workflow !== 0,
        branchName: row.branch_name,
        targetBranches: edges.targets.get(row.ref.toLowerCase()) ?? [],
        checkpointName: row.checkpoint_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        devCompletedAt: row.dev_completed_at,
        verifiedAt: row.verified_at,
        closedAt: row.closed_at,
    }
}

/* ------------------------------------------------------------- validation */

export function isStatus(value: string): value is Status {
    return (STATUSES as readonly string[]).includes(value)
}

export function isPriority(value: string): value is Priority {
    return (PRIORITIES as readonly string[]).includes(value)
}

export function isModelTier(value: string): value is ModelTier {
    return (MODEL_TIERS as readonly string[]).includes(value)
}

export function isInvestigationStatus(
    value: string,
): value is InvestigationStatus {
    return (INVESTIGATION_STATUSES as readonly string[]).includes(value)
}

/** Conservative Git branch validation, shared by CLI and HTTP callers. */
export function validateBranchName(value: string): string {
    const branch = value.trim()
    if (
        !branch ||
        branch.startsWith("/") ||
        branch.endsWith("/") ||
        branch.endsWith(".") ||
        branch.includes("//") ||
        branch.includes("..") ||
        branch.includes("@{") ||
        /[\s~^:?*\\[\\]/.test(branch) ||
        branch.split("/").some((part) => part === "." || part.endsWith(".lock"))
    ) {
        throw new Error(`Invalid Git branch name '${value}'.`)
    }
    return branch
}

/** Timestamp column that a given status stamps on entry. */
const STATUS_TIMESTAMP: Partial<Record<Status, string>> = {
    in_progress: "started_at",
    dev_complete: "dev_completed_at",
    verified: "verified_at",
    closed: "closed_at",
}

/* -------------------------------------------------------------- queries */

export function listTasks(filter?: {
    status?: Status
    tag?: string
    investigationRef?: string
    /** A work package's ref, or `'none'` for the tasks that are in no work package at all —
     *  the one filter that cannot be expressed as a ref. */
    workPackageRef?: string
    /** Keep closed tasks in the result. An investigation's own list uses this: a
     *  task it filed and saw through to closed is the outcome, not clutter. */
    includeClosed?: boolean
}): Task[] {
    const clauses: string[] = []
    const params: Record<string, string> = {}

    if (filter?.investigationRef) {
        clauses.push("investigation_ref = $investigation COLLATE NOCASE")
        params.$investigation = filter.investigationRef
    }
    if (filter?.workPackageRef) {
        if (filter.workPackageRef.toLowerCase() === "none") {
            clauses.push("work_package_ref IS NULL")
        } else {
            // Resolved rather than matched, so a work package named by its name filters the
            // same way one named by its ref does.
            clauses.push("work_package_ref = $workPackage COLLATE NOCASE")
            params.$workPackage = requireWorkPackage(filter.workPackageRef).ref
        }
    }
    if (filter?.status) {
        clauses.push("status = $status")
        params.$status = filter.status
    } else if (!filter?.includeClosed) {
        // Closed tasks remain auditable by explicit status query but no longer
        // clutter the normal task list.
        clauses.push("status != 'closed'")
    }
    if (filter?.tag) {
        // tags is a JSON array; match the quoted element to avoid substring hits.
        clauses.push("tags LIKE $tag")
        params.$tag = `%"${filter.tag}"%`
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    const rows = getDb()
        .query<TaskRow, typeof params>(
            // Manual order is the only order. Status and priority used to sort the
            // list; they now only describe a task, because the list is a queue the
            // user arranges and `/work-task` takes from the top of.
            `SELECT * FROM tasks ${where} ORDER BY position ASC, id DESC`,
        )
        .all(params)

    // One index for the whole page rather than one per row.
    const edges = dependencyIndex()
    return rows.map((row) => toTask(row, edges))
}

export function findTask(ref: string): Task | null {
    const row = getDb()
        .query<TaskRow, { $ref: string }>(
            "SELECT * FROM tasks WHERE ref = $ref COLLATE NOCASE",
        )
        .get({ $ref: ref })
    return row ? toTask(row) : null
}

/** Same as findTask but throws the message the CLI and API both want to show. */
export function requireTask(ref: string): Task {
    const task = findTask(ref)
    if (!task) throw new Error(`No task with ref '${ref}'.`)
    return task
}

export function listEvents(taskId: number): TaskEvent[] {
    return getDb()
        .query<
            {
                id: number
                task_id: number
                type: string
                from_status: string | null
                to_status: string | null
                note: string | null
                created_at: string
            },
            { $id: number }
        >("SELECT * FROM task_events WHERE task_id = $id ORDER BY id ASC")
        .all({ $id: taskId })
        .map((row) => ({
            id: row.id,
            taskId: row.task_id,
            type: row.type as TaskEvent["type"],
            fromStatus: row.from_status as Status | null,
            toStatus: row.to_status as Status | null,
            note: row.note,
            createdAt: row.created_at,
        }))
}

export function listRuns(taskId: number): CheckpointRun[] {
    const db = getDb()

    const runRows = db
        .query<
            {
                id: number
                task_id: number
                checkpoint_name: string
                phase: string
                exit_code: number
                git_head: string | null
                git_dirty: number | null
                scenario_count: number
                selection_json: string | null
                created_at: string
            },
            { $id: number }
        >("SELECT * FROM checkpoint_runs WHERE task_id = $id ORDER BY id ASC")
        .all({ $id: taskId })

    const comparisonRows = db
        .query<
            {
                id: number
                run_id: number
                scenario: string
                description: string | null
                status: string
                percent_changed: number | null
                pixel_diff_count: number | null
                total_pixels: number | null
                before_path: string | null
                after_path: string | null
                diff_path: string | null
                browser_log_status: string | null
                browser_log_change_count: number | null
            },
            { $id: number }
        >(
            `SELECT c.* FROM checkpoint_comparisons c
       JOIN checkpoint_runs r ON r.id = c.run_id
       WHERE r.task_id = $id
       ORDER BY c.id ASC`,
        )
        .all({ $id: taskId })

    const byRun = new Map<number, Comparison[]>()
    for (const row of comparisonRows) {
        const comparison: Comparison = {
            id: row.id,
            runId: row.run_id,
            scenario: row.scenario,
            description: row.description,
            status: row.status as Comparison["status"],
            percentChanged: row.percent_changed,
            pixelDiffCount: row.pixel_diff_count,
            totalPixels: row.total_pixels,
            beforePath: row.before_path,
            afterPath: row.after_path,
            diffPath: row.diff_path,
            browserLogStatus: row.browser_log_status,
            browserLogChangeCount: row.browser_log_change_count,
        }
        const bucket = byRun.get(row.run_id)
        if (bucket) bucket.push(comparison)
        else byRun.set(row.run_id, [comparison])
    }

    return runRows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        checkpointName: row.checkpoint_name,
        phase: row.phase as Phase,
        exitCode: row.exit_code,
        gitHead: row.git_head,
        gitDirty: row.git_dirty,
        scenarioCount: row.scenario_count,
        selection: row.selection_json ? JSON.parse(row.selection_json) : null,
        createdAt: row.created_at,
        comparisons: byRun.get(row.id) ?? [],
    }))
}

export function getTaskDetail(ref: string): TaskDetail {
    const task = requireTask(ref)
    return {
        ...task,
        events: listEvents(task.id),
        runs: listRuns(task.id),
        attachments: listTaskAttachments(task.ref),
    }
}

/* -------------------------------------------------------------- mutations */

function addEvent(
    taskId: number,
    type: TaskEvent["type"],
    fields: {
        fromStatus?: Status | null
        toStatus?: Status | null
        note?: string | null
    } = {},
): void {
    getDb()
        .query(
            `INSERT INTO task_events (task_id, type, from_status, to_status, note, created_at)
       VALUES ($task, $type, $from, $to, $note, $at)`,
        )
        .run({
            $task: taskId,
            $type: type,
            $from: fields.fromStatus ?? null,
            $to: fields.toStatus ?? null,
            $note: fields.note ?? null,
            $at: nowIso(),
        })
}

export interface CreateInput {
    title: string
    description?: string
    priority?: Priority
    /** The capability tier an investigation thinks this task needs. Left unset
     *  (rather than defaulted) when nobody has judged it — unlike `priority`,
     *  which always has one. */
    recommendedTier?: ModelTier | null
    tags?: string[]
    /** Defaults to true. False skips task branching, committing and merging. */
    useGitWorkflow?: boolean
    branchName?: string
    /** The investigation this task came out of, if any. Validated here so a typo'd
     *  ref fails loudly rather than producing a task nothing links to. */
    investigationRef?: string
    /** The work package to file it under, by ref or by name. A task filed against an
     *  investigation may omit this and lands in that investigation's work package.
     *  Other new tasks must name a work package; null remains in the type only so old
     *  unassigned records can still be read. */
    workPackageRef?: string | null
    /** Refs of tasks this one has to wait for. */
    dependsOn?: string[]
    /** Plan duration in units. Defaults to one. */
    estimateUnits?: number
    /** The work package branch to put it on. Left out, it goes on the work
     *  package's newest branch; null puts it on none. */
    branchId?: number | null
}

export function createTask(input: CreateInput): Task {
    const title = input.title.trim()
    if (!title) throw new Error("A task needs a title.")

    // Resolved before the ref counter is bumped, so a typo'd investigation does
    // not silently burn a task number.
    const investigation = input.investigationRef
        ? requireInvestigation(input.investigationRef).ref
        : null
    // An explicit work package wins. Otherwise an investigation supplies its own work package.
    // Null used to mean "loose"; new work may no longer enter that legacy bucket.
    if (
        input.workPackageRef === null ||
        (input.workPackageRef === undefined && !investigation)
    ) {
        throw new Error(
            "A new task must belong to a work package. Pass a work package or an investigation.",
        )
    }
    const workPackage =
        input.workPackageRef === undefined
            ? workPackageForInvestigation(investigation!).ref
            : requireWorkPackage(input.workPackageRef).ref
    const targetBranch =
        input.branchId === undefined
            ? newestBranchOf(workPackage)
            : input.branchId === null
              ? null
              : requireWorkPackageBranch(input.branchId)
    if (targetBranch && targetBranch.workPackageRef !== workPackage) {
        throw new Error(
            `Branch '${targetBranch.branchName}' belongs to ${targetBranch.workPackageRef}, not ${workPackage}.`,
        )
    }
    // Same reasoning as the investigation above: a ref that does not resolve must
    // fail before the task exists, not leave one behind with half its blockers.
    const blockers = [
        ...new Set((input.dependsOn ?? []).map((one) => requireTask(one).ref)),
    ]
    const estimateUnits =
        input.estimateUnits === undefined
            ? DEFAULT_ESTIMATE_UNITS
            : parseEstimateUnits(input.estimateUnits)

    const at = nowIso()
    const ref = nextRef()
    const useGitWorkflow = input.useGitWorkflow ?? true
    if (!useGitWorkflow && input.branchName !== undefined) {
        throw new Error(
            "A task cannot have a branch when its Git workflow is disabled.",
        )
    }
    const branchName = !useGitWorkflow
        ? null
        : input.branchName === undefined
          ? branchNameFor(ref, title, workspace().config.branchPrefix)
          : validateBranchName(input.branchName)

    getDb()
        .query(
            `INSERT INTO tasks (ref, title, description, status, priority, recommended_tier, position, tags,
                          estimate_units, use_git_workflow, branch_name, investigation_ref, work_package_ref, checkpoint_name,
                          created_at, updated_at)
       VALUES ($ref, $title, $description, 'backlog', $priority, $tier, $position, $tags,
               $units, $useGitWorkflow, $branch, $investigation, $workPackage, $checkpoint, $at, $at)`,
        )
        .run({
            $ref: ref,
            $title: title,
            // Appended, never promoted: the list is a queue the user arranges, and a
            // task filed mid-session must not silently become the next one worked.
            // Batch filing (an investigation's tasks) therefore keeps its filing order.
            $position: bottomPosition(),
            $description: input.description?.trim() ?? "",
            $priority: input.priority ?? "medium",
            $tier: input.recommendedTier ?? null,
            $tags: JSON.stringify(input.tags ?? []),
            $units: estimateUnits,
            $useGitWorkflow: useGitWorkflow ? 1 : 0,
            $branch: branchName,
            $investigation: investigation,
            $workPackage: workPackage,
            $checkpoint: checkpointNameFor(
                ref,
                workspace().config.checkpointPrefix,
            ),
            $at: at,
        })

    const task = requireTask(ref)
    addEvent(task.id, "created", {
        toStatus: "backlog",
        note: investigation ? `${title} (from ${investigation})` : title,
    })
    if (targetBranch) insertBranchTasks(targetBranch.id, [task.ref])
    // A brand-new task cannot be part of a cycle, so this only ever inserts.
    for (const blockerRef of blockers) addDependency(task.ref, blockerRef)
    return requireTask(ref)
}

export interface UpdateInput {
    title?: string
    description?: string
    priority?: Priority
    /** Pass null to clear a previous recommendation. */
    recommendedTier?: ModelTier | null
    /** Enable or disable task-level branching and merging. */
    useGitWorkflow?: boolean
    tags?: string[]
    /** Link the task to an investigation, or pass null to unlink it. */
    investigationRef?: string | null
    /** Move it into a work package by ref or name, or pass null to take it out of one. */
    workPackageRef?: string | null
    /** Replaces the task's blockers outright; an empty array clears them. */
    dependsOn?: string[]
    /** Plan duration in units. */
    estimateUnits?: number
}

export function updateTask(ref: string, input: UpdateInput): Task {
    const task = requireTask(ref)

    // Dependencies live in their own table and write their own history, so they
    // are applied around the column update rather than folded into it.
    if (input.dependsOn !== undefined)
        setDependencies(task.ref, input.dependsOn)

    const assignments: string[] = []
    const params: Record<string, string | number | null> = {
        $ref: task.ref,
        $at: nowIso(),
    }
    const changed: string[] = []

    if (input.title !== undefined) {
        const title = input.title.trim()
        if (!title) throw new Error("A task needs a title.")
        assignments.push("title = $title")
        params.$title = title
        changed.push("title")
    }
    if (input.description !== undefined) {
        assignments.push("description = $description")
        params.$description = input.description
        changed.push("description")
    }
    if (input.priority !== undefined) {
        assignments.push("priority = $priority")
        params.$priority = input.priority
        changed.push("priority")
    }
    if (input.recommendedTier !== undefined) {
        assignments.push("recommended_tier = $tier")
        params.$tier = input.recommendedTier
        changed.push("recommended tier")
    }
    if (input.useGitWorkflow !== undefined) {
        assignments.push("use_git_workflow = $useGitWorkflow")
        params.$useGitWorkflow = input.useGitWorkflow ? 1 : 0
        changed.push("Git workflow")
        if (!input.useGitWorkflow) {
            assignments.push("branch_name = NULL")
        } else if (!task.branchName) {
            assignments.push("branch_name = $generatedBranch")
            params.$generatedBranch = branchNameFor(
                task.ref,
                input.title?.trim() || task.title,
                workspace().config.branchPrefix,
            )
        }
    }
    if (input.tags !== undefined) {
        assignments.push("tags = $tags")
        params.$tags = JSON.stringify(input.tags)
        changed.push("tags")
    }
    if (input.estimateUnits !== undefined) {
        assignments.push("estimate_units = $units")
        params.$units = parseEstimateUnits(input.estimateUnits)
        changed.push("estimate")
    }
    if (input.investigationRef !== undefined) {
        assignments.push("investigation_ref = $investigation")
        params.$investigation = input.investigationRef
            ? requireInvestigation(input.investigationRef).ref
            : null
        changed.push("investigation")
    }
    if (input.workPackageRef !== undefined) {
        if (!input.workPackageRef) {
            throw new Error(
                "Tasks must belong to a work package. Choose another work package instead.",
            )
        }
        assignments.push("work_package_ref = $workPackage")
        params.$workPackage = requireWorkPackage(input.workPackageRef).ref
        changed.push("work-package")
    }

    // Re-read: a dependency change above is a change even when no column moved.
    if (!assignments.length) return requireTask(task.ref)

    getDb()
        .query(
            `UPDATE tasks SET ${assignments.join(", ")}, updated_at = $at WHERE ref = $ref`,
        )
        .run(params)

    addEvent(task.id, "edited", { note: `changed ${changed.join(", ")}` })
    return requireTask(task.ref)
}

export function setStatus(ref: string, status: Status, note?: string): Task {
    const task = requireTask(ref)
    if (task.status === status) return task

    const at = nowIso()
    const stamp = STATUS_TIMESTAMP[status]
    // Re-entering a state refreshes its timestamp, so a reopened task reports
    // when it most recently reached dev_complete rather than the first time.
    const stampClause = stamp ? `, ${stamp} = $at` : ""

    getDb()
        .query(
            `UPDATE tasks SET status = $status, updated_at = $at${stampClause} WHERE ref = $ref`,
        )
        .run({ $status: status, $at: at, $ref: task.ref })

    addEvent(task.id, "status", {
        fromStatus: task.status,
        toStatus: status,
        note: note ?? null,
    })
    return requireTask(task.ref)
}

export function addNote(ref: string, note: string): Task {
    const task = requireTask(ref)
    const text = note.trim()
    if (!text) throw new Error("An empty note is not worth recording.")

    addEvent(task.id, "note", { note: text })
    getDb()
        .query("UPDATE tasks SET updated_at = $at WHERE ref = $ref")
        .run({ $at: nowIso(), $ref: task.ref })

    return requireTask(task.ref)
}

export function deleteTask(ref: string): void {
    const task = requireTask(ref)
    getDb().transaction(() => {
        getDb()
            .query("DELETE FROM branch_tasks WHERE task_ref = $ref")
            .run({ $ref: task.ref })
        getDb().query("DELETE FROM tasks WHERE id = $id").run({ $id: task.id })
    })()
    deleteTaskAttachments(task.ref)
}

/* ------------------------------------------------------------ dependencies */

/**
 * Would `blockerRef` end up depending on `ref`, directly or through a chain?
 *
 * Walks the existing edges forward from the proposed blocker. Cycles are
 * rejected at write time rather than tolerated and worked around at read time:
 * a cycle means every task in it is permanently blocked, which is never what
 * anybody meant to record.
 */
function dependsOnTransitively(fromRef: string, targetRef: string): boolean {
    const { dependsOn } = dependencyIndex()
    const seen = new Set<string>()
    const queue = [fromRef]

    while (queue.length) {
        const current = queue.shift()!
        if (current === targetRef) return true
        if (seen.has(current)) continue
        seen.add(current)
        queue.push(...(dependsOn.get(current) ?? []))
    }
    return false
}

/** Record that `ref` waits for `blockerRef`. Idempotent. */
export function addDependency(ref: string, blockerRef: string): Task {
    const task = requireTask(ref)
    const blocker = requireTask(blockerRef)

    if (task.ref === blocker.ref)
        throw new Error(`${task.ref} cannot depend on itself.`)
    if (task.dependsOn.includes(blocker.ref)) return task
    if (dependsOnTransitively(blocker.ref, task.ref)) {
        throw new Error(
            `${blocker.ref} already depends on ${task.ref}, so this would make a circular dependency.`,
        )
    }

    getDb()
        .query(
            `INSERT INTO task_dependencies (task_id, depends_on_id, created_at)
       VALUES ($task, $blocker, $at)
       ON CONFLICT DO NOTHING`,
        )
        .run({ $task: task.id, $blocker: blocker.id, $at: nowIso() })

    touch(task.ref)
    addEvent(task.id, "edited", {
        note: `now depends on ${blocker.ref} (${blocker.title})`,
    })
    return requireTask(task.ref)
}

export function removeDependency(ref: string, blockerRef: string): Task {
    const task = requireTask(ref)
    const blocker = requireTask(blockerRef)
    if (!task.dependsOn.includes(blocker.ref)) return task

    getDb()
        .query(
            "DELETE FROM task_dependencies WHERE task_id = $task AND depends_on_id = $blocker",
        )
        .run({ $task: task.id, $blocker: blocker.id })

    touch(task.ref)
    addEvent(task.id, "edited", { note: `no longer depends on ${blocker.ref}` })
    return requireTask(task.ref)
}

/** Replace a task's blockers wholesale — what the UI's editor and the CLI's
 *  `--depends-on` both want. Expressed as a diff so the history says what
 *  actually changed rather than "dependencies edited". */
export function setDependencies(ref: string, blockerRefs: string[]): Task {
    const task = requireTask(ref)
    // Resolved first so a typo in the middle of a list cannot half-apply.
    const wanted = [...new Set(blockerRefs.map((one) => requireTask(one).ref))]

    for (const blockerRef of task.dependsOn) {
        if (!wanted.includes(blockerRef)) removeDependency(task.ref, blockerRef)
    }
    for (const blockerRef of wanted) addDependency(task.ref, blockerRef)

    return requireTask(task.ref)
}

/** Bump `updated_at` for a change that lives in another table. */
function touch(ref: string): void {
    getDb()
        .query("UPDATE tasks SET updated_at = $at WHERE ref = $ref")
        .run({ $at: nowIso(), $ref: ref })
}

/* ------------------------------------------------------------- list order */

/** One past the last position in use — where a newly filed task goes. */
function bottomPosition(): number {
    const row = getDb()
        .query<{ top: number | null }, []>(
            "SELECT MAX(position) AS top FROM tasks",
        )
        .get()
    return (row?.top ?? 0) + 1
}

/**
 * Rearrange the given tasks into the given order.
 *
 * Only the positions those tasks already occupy are redistributed among them,
 * so this is a permutation and nothing outside `refs` moves. That is what makes
 * it safe to call from a filtered view: dragging within "Backlog" reshuffles the
 * backlog rows and leaves the in-progress rows interleaved between them exactly
 * where they were.
 */
export function reorderTasks(refs: string[]): Task[] {
    const tasks = refs.map((ref) => requireTask(ref))

    const seen = new Set<string>()
    for (const task of tasks) {
        if (seen.has(task.ref))
            throw new Error(`Task '${task.ref}' listed twice in the new order.`)
        seen.add(task.ref)
    }
    if (tasks.length < 2) return tasks

    const slots = tasks
        .map((task) => task.position)
        .sort((left, right) => left - right)
    const assign = getDb().query(
        "UPDATE tasks SET position = $position WHERE id = $id",
    )

    getDb().transaction(() => {
        tasks.forEach((task, index) =>
            assign.run({ $id: task.id, $position: slots[index]! }),
        )
    })()

    return tasks.map((task) => requireTask(task.ref))
}

export type MoveTarget =
    | { to: "top" | "bottom" | "up" | "down" }
    | { to: "before" | "after"; ref: string }

/**
 * Move one task within the full (non-closed) list. Expressed against that list
 * rather than raw position arithmetic so `up` means "swap with the row above it
 * on screen" even when positions are sparse.
 */
export function moveTask(ref: string, target: MoveTarget): Task[] {
    const task = requireTask(ref)
    const order = listTasks().map((one) => one.ref)
    const from = order.indexOf(task.ref)
    if (from === -1) {
        throw new Error(
            `Task '${task.ref}' is closed and is not in the ordered list.`,
        )
    }

    let to: number
    if (target.to === "before" || target.to === "after") {
        const anchor = requireTask(target.ref)
        if (anchor.ref === task.ref)
            throw new Error("A task cannot be moved relative to itself.")
        const at = order.indexOf(anchor.ref)
        if (at === -1)
            throw new Error(
                `Task '${anchor.ref}' is closed and is not in the ordered list.`,
            )
        // Removing the task first shifts everything after it up by one, so an
        // anchor below the task needs no further adjustment for 'before'.
        to = at + (target.to === "after" ? 1 : 0) - (at > from ? 1 : 0)
    } else if (target.to === "top") to = 0
    else if (target.to === "bottom") to = order.length - 1
    else if (target.to === "up") to = from - 1
    else to = from + 1

    to = Math.max(0, Math.min(order.length - 1, to))
    if (to === from) return listTasks()

    order.splice(to, 0, ...order.splice(from, 1))
    reorderTasks(order)
    return listTasks()
}

/* ---------------------------------------------------------------- work packages */

interface WorkPackageRow {
    id: number
    ref: string
    name: string
    color: string
    position: number
    created_at: string
    updated_at: string
}

function toWorkPackage(row: WorkPackageRow): WorkPackage {
    return {
        id: row.id,
        ref: row.ref,
        name: row.name,
        color: row.color,
        position: row.position,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

/**
 * Every work package, with what is in it, in the order the views draw them.
 *
 * Ordered by the queue position of the work package's first task, so the grouped list
 * reads top to bottom in the same order as the unassigned one — the work package a task
 * is in changes how the list is *sectioned*, never which work is next. Work packages
 * with nothing in them sort after, by their own position.
 */
export function listWorkPackages(): WorkPackageSummary[] {
    const briefs = new Map<string, string>()
    for (const row of getDb()
        .query<{ work_package_ref: string; brief: string }, []>(
            `SELECT work_package_ref, brief FROM investigations
          WHERE work_package_ref IS NOT NULL ORDER BY id DESC`,
        )
        .all()) {
        // Descending, so the oldest investigation is the one left standing.
        briefs.set(row.work_package_ref.toLowerCase(), row.brief)
    }
    const branches = new Map<string, string[]>()
    for (const row of getDb()
        .query<{ work_package_ref: string; branch_name: string }, []>(
            "SELECT work_package_ref, branch_name FROM work_package_branches ORDER BY id",
        )
        .all()) {
        const key = row.work_package_ref.toLowerCase()
        branches.set(key, [...(branches.get(key) ?? []), row.branch_name])
    }

    return getDb()
        .query<
            WorkPackageRow & {
                task_count: number
                dev_complete_count: number
                open_count: number
            },
            []
        >(
            // The work package's columns are named rather than taken as `g.*`. A `*` ahead of
            // aliased aggregates means adding a column later shifts `task_count` and
            // `open_count` along by one — which a long-running process, holding a
            // statement prepared before the migration, serves as silently mislabelled
            // values rather than as an error.
            `SELECT g.id, g.ref, g.name, g.color, g.position, g.created_at, g.updated_at,
              COUNT(t.id) AS task_count,
              COUNT(CASE WHEN t.status IN ('dev_complete', 'verified', 'closed') THEN 1 END) AS dev_complete_count,
              COUNT(CASE WHEN t.status != 'closed' THEN 1 END) AS open_count
         FROM work_packages g
         LEFT JOIN tasks t ON t.work_package_ref = g.ref COLLATE NOCASE
        GROUP BY g.id
        ORDER BY COALESCE(MIN(CASE WHEN t.status != 'closed' THEN t.position END), 1e15) ASC,
                 g.position ASC,
                 g.id ASC`,
        )
        .all()
        .map((row) => ({
            ...toWorkPackage(row),
            brief: briefs.get(row.ref.toLowerCase()) ?? "",
            branchNames: branches.get(row.ref.toLowerCase()) ?? [],
            taskCount: row.task_count,
            devCompleteCount: row.dev_complete_count,
            openCount: row.open_count,
        }))
}

/**
 * A work package by ref or by name, case-insensitively.
 *
 * Names are accepted because that is what a person typing a command has to
 * hand — `tasks work-package assign "Search rework" T-4` beats looking WP-2 up first.
 * The ref is tried first, so a work package someone named `WP-2` cannot shadow the
 * work package actually called that.
 */
export function findWorkPackage(refOrName: string): WorkPackage | null {
    const value = refOrName.trim()
    if (!value) return null

    const row = getDb()
        .query<WorkPackageRow, { $value: string }>(
            `SELECT * FROM work_packages
        WHERE ref = $value COLLATE NOCASE OR name = $value COLLATE NOCASE
        ORDER BY CASE WHEN ref = $value COLLATE NOCASE THEN 0 ELSE 1 END, id ASC`,
        )
        .get({ $value: value })
    return row ? toWorkPackage(row) : null
}

export function requireWorkPackage(refOrName: string): WorkPackage {
    const workPackage = findWorkPackage(refOrName)
    if (!workPackage)
        throw new Error(`No work package with ref or name '${refOrName}'.`)
    return workPackage
}

/** One past the last work package position in use — where a new work package goes. */
function bottomWorkPackagePosition(): number {
    const row = getDb()
        .query<{ top: number | null }, []>(
            "SELECT MAX(position) AS top FROM work_packages",
        )
        .get()
    return (row?.top ?? 0) + 1
}

export interface CreateWorkPackageInput {
    name: string
    /** `#rrggbb`. Left out, the next unused colour in `WORK_PACKAGE_COLORS` is taken. */
    color?: string
    /** Investigations to write down with it. A missing title takes the work package's name. */
    investigations?: { title?: string; brief?: string }[]
    /** Branches to deliver through. Each takes every open task, which on a new
     *  work package is none — tasks join the newest branch as they are filed. */
    branches?: Omit<CreateWorkPackageBranchInput, "workPackageRef">[]
}

/**
 * Create a work package, and whatever investigations and branches it starts
 * with, as one write — a rejected branch name must not leave a work package and
 * an orphan investigation behind.
 */
export function createWorkPackage(input: CreateWorkPackageInput): WorkPackage {
    return getDb().transaction(() => {
        const name = input.name.trim()
        if (!name) throw new Error("A work package needs a name.")
        // Two work packages with the same name would make `findWorkPackage` a coin toss, and the
        // name is how the CLI addresses one.
        if (findWorkPackage(name))
            throw new Error(`A work package called '${name}' already exists.`)

        const color = input.color?.trim()
            ? validateWorkPackageColor(input.color)
            : nextWorkPackageColor(
                  getDb()
                      .query<{ color: string }, []>(
                          "SELECT color FROM work_packages",
                      )
                      .all()
                      .map((row) => row.color),
              )

        const at = nowIso()
        const ref = nextWorkPackageRef()
        getDb()
            .query(
                `INSERT INTO work_packages (ref, name, color, position, created_at, updated_at)
       VALUES ($ref, $name, $color, $position, $at, $at)`,
            )
            .run({
                $ref: ref,
                $name: name,
                $color: color,
                $position: bottomWorkPackagePosition(),
                $at: at,
            })

        for (const investigation of input.investigations ?? []) {
            createInvestigation({
                title: investigation.title?.trim() || name,
                brief: investigation.brief,
                workPackageRef: ref,
            })
        }
        for (const branch of input.branches ?? [])
            createWorkPackageBranch({ ...branch, workPackageRef: ref })

        return requireWorkPackage(ref)
    })()
}

function validateWorkPackageColor(value: string): string {
    const color = value.trim()
    if (!isWorkPackageColor(color)) {
        throw new Error(
            `A work package colour must be a hex value like '#5b9dff', not '${value}'.`,
        )
    }
    return color.toLowerCase()
}

export function updateWorkPackage(
    refOrName: string,
    input: {
        name?: string
        color?: string
    },
): WorkPackage {
    const workPackage = requireWorkPackage(refOrName)
    const assignments: string[] = []
    const params: Record<string, string | number | null> = {
        $ref: workPackage.ref,
        $at: nowIso(),
    }

    if (input.name !== undefined) {
        const name = input.name.trim()
        if (!name) throw new Error("A work package needs a name.")
        const clash = findWorkPackage(name)
        if (clash && clash.ref !== workPackage.ref)
            throw new Error(`A work package called '${name}' already exists.`)
        assignments.push("name = $name")
        params.$name = name
    }
    if (input.color !== undefined) {
        assignments.push("color = $color")
        params.$color = validateWorkPackageColor(input.color)
    }

    if (!assignments.length) return workPackage

    getDb()
        .query(
            `UPDATE work_packages SET ${assignments.join(", ")}, updated_at = $at WHERE ref = $ref`,
        )
        .run(params)
    return requireWorkPackage(workPackage.ref)
}

/**
 * Delete the organizing, not the work. A work package that still has tasks is
 * refused; its investigations are kept and unlinked, and its branch records go —
 * the Git branches themselves are left alone.
 */
export function deleteWorkPackage(refOrName: string): {
    ref: string
    released: string[]
} {
    const workPackage = requireWorkPackage(refOrName)
    const released = listTasks({
        workPackageRef: workPackage.ref,
        includeClosed: true,
    }).map((task) => task.ref)

    if (released.length) {
        throw new Error(
            `${workPackage.ref} still has ${released.length} task(s). Move them to another work package before deleting it.`,
        )
    }

    getDb().transaction(() => {
        getDb()
            .query(
                "UPDATE investigations SET work_package_ref = NULL, updated_at = $at WHERE work_package_ref = $ref COLLATE NOCASE",
            )
            .run({ $at: nowIso(), $ref: workPackage.ref })
        getDb()
            .query(
                "DELETE FROM work_package_branches WHERE work_package_ref = $ref COLLATE NOCASE",
            )
            .run({ $ref: workPackage.ref })
        getDb()
            .query(
                "DELETE FROM work_runs WHERE work_package_ref = $ref COLLATE NOCASE",
            )
            .run({ $ref: workPackage.ref })
        getDb()
            .query("DELETE FROM work_packages WHERE id = $id")
            .run({ $id: workPackage.id })
    })()

    return { ref: workPackage.ref, released }
}

/**
 * Rearrange the work packages. Only the positions the named work packages already occupy are
 * redistributed among them, exactly as `reorderTasks` does for tasks.
 *
 * Worth remembering what this actually decides: a work package holding tasks is drawn
 * where its first task sits in the queue, so this is what orders the *empty*
 * ones and settles ties. Moving a work package's work up the queue is a task reorder.
 */
export function reorderWorkPackages(refs: string[]): WorkPackageSummary[] {
    const workPackages = refs.map((ref) => requireWorkPackage(ref))
    const seen = new Set<string>()
    for (const workPackage of workPackages) {
        if (seen.has(workPackage.ref))
            throw new Error(
                `Work package '${workPackage.ref}' listed twice in the new order.`,
            )
        seen.add(workPackage.ref)
    }
    if (workPackages.length < 2) return listWorkPackages()

    const slots = workPackages
        .map((workPackage) => workPackage.position)
        .sort((left, right) => left - right)
    const assign = getDb().query(
        "UPDATE work_packages SET position = $position WHERE id = $id",
    )
    getDb().transaction(() => {
        workPackages.forEach((workPackage, index) =>
            assign.run({ $id: workPackage.id, $position: slots[index]! }),
        )
    })()

    return listWorkPackages()
}

/**
 * Put a task in a work package, or take it out of one.
 *
 * By default the task is also moved to sit directly after the work package's last
 * member in the queue, which is what keeps a work package contiguous — and therefore
 * what keeps the grouped list in the same order as the flat one. A caller that
 * has just been told where to drop the row (the UI's drag) passes
 * `reposition: false` and sets the order itself.
 *
 * Its branch assignments move with it: off the old work package's branches, and
 * onto the new one's newest branch, the same place a task filed there would go.
 */
export function setWorkPackage(
    ref: string,
    workPackageRefOrName: string | null,
    options: { reposition?: boolean } = {},
): Task {
    const task = requireTask(ref)
    if (!workPackageRefOrName) {
        throw new Error(
            "Tasks must belong to a work package. Choose another work package instead.",
        )
    }
    const workPackage = requireWorkPackage(workPackageRefOrName)
    if ((task.workPackageRef ?? null) === workPackage.ref) return task

    getDb().transaction(() => {
        getDb()
            .query(
                "UPDATE tasks SET work_package_ref = $workPackage, updated_at = $at WHERE ref = $ref",
            )
            .run({
                $workPackage: workPackage.ref,
                $at: nowIso(),
                $ref: task.ref,
            })
        getDb()
            .query("DELETE FROM branch_tasks WHERE task_ref = $ref")
            .run({ $ref: task.ref })
        const branch = newestBranchOf(workPackage.ref)
        if (branch) insertBranchTasks(branch.id, [task.ref])
    })()

    addEvent(task.id, "edited", {
        note: `moved into work package ${workPackage.ref} (${workPackage.name})`,
    })

    if (options.reposition !== false)
        appendToWorkPackageRun(task.ref, workPackage.ref)
    return requireTask(task.ref)
}

/** Move `ref` to just after the last task already in `workPackageRef`, when there is
 *  one and both rows are in the ordered list. Closed tasks have no place in the
 *  queue, so a work package made only of them simply leaves the task where it is. */
function appendToWorkPackageRun(ref: string, workPackageRef: string): void {
    const order = listTasks()
    const anchor = [...order]
        .reverse()
        .find(
            (one) =>
                one.ref !== ref &&
                one.workPackageRef?.toLowerCase() ===
                    workPackageRef.toLowerCase(),
        )
    if (!anchor || !order.some((one) => one.ref === ref)) return

    moveTask(ref, { to: "after", ref: anchor.ref })
}

/**
 * The work package holding an investigation's tasks, made if it is not there yet.
 *
 * An investigation written down inside a work package already names it. One
 * written down on its own gets a work package, with a branch, when it files its
 * first task, and is linked to it — so running the same investigation twice
 * refills the one that exists instead of making a second beside it.
 */
export function workPackageForInvestigation(
    investigationRef: string,
): WorkPackage {
    const investigation = requireInvestigation(investigationRef)
    const existing = investigation.workPackageRef
        ? findWorkPackage(investigation.workPackageRef)
        : null
    if (existing) return existing

    // The investigation's own title is the name people already know it by. A
    // second work package that happens to be called that is disambiguated with the ref
    // rather than refused: auto-organizing must never fail a task's creation.
    const base = investigation.title.trim() || investigation.ref
    const name = findWorkPackage(base) ? `${base} (${investigation.ref})` : base
    return getDb().transaction(() => {
        const workPackage = createWorkPackage({ name, branches: [{}] })
        getDb()
            .query(
                "UPDATE investigations SET work_package_ref = $workPackage WHERE ref = $ref",
            )
            .run({ $workPackage: workPackage.ref, $ref: investigation.ref })
        return workPackage
    })()
}

/* ------------------------------------------------------ work package branches */

interface WorkPackageBranchRow {
    id: number
    work_package_ref: string
    label: string
    branch_name: string
    base_branch: string | null
    origin: string
    created_at: string
    updated_at: string
}

function toWorkPackageBranch(row: WorkPackageBranchRow): WorkPackageBranch {
    return {
        id: row.id,
        workPackageRef: row.work_package_ref,
        label: row.label,
        branchName: row.branch_name,
        baseBranch: row.base_branch,
        origin: row.origin === "existing" ? "existing" : "new",
        taskRefs: getDb()
            .query<{ task_ref: string }, { $id: number }>(
                "SELECT task_ref FROM branch_tasks WHERE branch_id = $id ORDER BY id",
            )
            .all({ $id: row.id })
            .map((one) => one.task_ref),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

/** A work package's branches, oldest first — the order its tabs are drawn in. */
export function listWorkPackageBranches(
    workPackageRef: string,
): WorkPackageBranch[] {
    return getDb()
        .query<WorkPackageBranchRow, { $ref: string }>(
            "SELECT * FROM work_package_branches WHERE work_package_ref = $ref COLLATE NOCASE ORDER BY id",
        )
        .all({ $ref: requireWorkPackage(workPackageRef).ref })
        .map(toWorkPackageBranch)
}

export function findWorkPackageBranch(id: number): WorkPackageBranch | null {
    const row = getDb()
        .query<WorkPackageBranchRow, { $id: number }>(
            "SELECT * FROM work_package_branches WHERE id = $id",
        )
        .get({ $id: id })
    return row ? toWorkPackageBranch(row) : null
}

export function requireWorkPackageBranch(id: number): WorkPackageBranch {
    const branch = findWorkPackageBranch(id)
    if (!branch) throw new Error(`No work package branch with id ${id}.`)
    return branch
}

/** The work package branch with this Git name, whichever work package it is in. */
export function findWorkPackageBranchByName(
    branchName: string,
): WorkPackageBranch | null {
    const row = getDb()
        .query<WorkPackageBranchRow, { $name: string }>(
            "SELECT * FROM work_package_branches WHERE branch_name = $name COLLATE NOCASE",
        )
        .get({ $name: branchName })
    return row ? toWorkPackageBranch(row) : null
}

/**
 * One of a work package's branches, by whatever a person has to hand: its id,
 * its Git name, or its tab label. A label shared by two branches is refused
 * rather than guessed at.
 */
export function resolveWorkPackageBranch(
    workPackageRef: string,
    key: string,
): WorkPackageBranch {
    const workPackage = requireWorkPackage(workPackageRef)
    const branches = listWorkPackageBranches(workPackage.ref)
    const value = key.trim()
    const lower = value.toLowerCase()

    const byId = /^\d+$/.test(value)
        ? branches.find((one) => one.id === Number(value))
        : undefined
    if (byId) return byId
    const byName = branches.find(
        (one) => one.branchName.toLowerCase() === lower,
    )
    if (byName) return byName
    const byLabel = branches.filter((one) => one.label.toLowerCase() === lower)
    if (byLabel.length === 1) return byLabel[0]!
    if (byLabel.length > 1) {
        throw new Error(
            `${byLabel.length} of ${workPackage.ref}'s branches are labelled '${value}'. Name one by its Git branch or id.`,
        )
    }
    throw new Error(`${workPackage.ref} has no branch '${value}'.`)
}

/**
 * Where a newly filed task goes: the work package's most recently added branch.
 * The newest branch is the one still being put together; older ones are more
 * likely to be out for review already.
 */
export function newestBranchOf(
    workPackageRef: string,
): WorkPackageBranch | null {
    const row = getDb()
        .query<WorkPackageBranchRow, { $ref: string }>(
            "SELECT * FROM work_package_branches WHERE work_package_ref = $ref COLLATE NOCASE ORDER BY id DESC LIMIT 1",
        )
        .get({ $ref: workPackageRef })
    return row ? toWorkPackageBranch(row) : null
}

/** No two work package branches may share a Git branch, or merging a task into
 *  "its" branch would silently deliver it under another work package's name. */
function assertBranchUnclaimed(branch: string, exceptId?: number): void {
    const clash = findWorkPackageBranchByName(branch)
    if (clash && clash.id !== exceptId) {
        throw new Error(
            `Branch '${branch}' is already a branch of ${clash.workPackageRef} ('${clash.label}').`,
        )
    }
}

export interface CreateWorkPackageBranchInput {
    workPackageRef: string
    /** The tab's name. Defaults to "Branch", then "Branch 2" and so on. */
    label?: string
    /** The Git branch. Required when adopting an existing one; otherwise derived
     *  from the work package's ref and name. */
    branchName?: string
    /** Adopt a local branch that already exists, rather than name a new one. */
    existing?: boolean
    /** What a new branch is cut from and its PR targets. Left out, the base branch. */
    baseBranch?: string | null
    /** Tasks to put on it. Left out, every task in the work package that is not
     *  yet Dev Complete, plus finished ones that are on no other branch. */
    taskRefs?: string[]
}

export function createWorkPackageBranch(
    input: CreateWorkPackageBranchInput,
): WorkPackageBranch {
    const workPackage = requireWorkPackage(input.workPackageRef)
    const siblings = listWorkPackageBranches(workPackage.ref)
    const label =
        input.label?.trim() ||
        (siblings.length ? `Branch ${siblings.length + 1}` : "Branch")

    let branch: string
    if (input.existing) {
        if (!input.branchName?.trim())
            throw new Error("Name the existing branch to adopt.")
        branch = validateBranchName(input.branchName)
        if (!branchExists(branch))
            throw new Error(`There is no local branch '${branch}' to adopt.`)
        assertBranchUnclaimed(branch)
    } else if (input.branchName?.trim()) {
        branch = validateBranchName(input.branchName)
        assertBranchUnclaimed(branch)
        // Quietly adopting a branch someone meant to create fresh would deliver
        // whatever is already on it.
        if (branchExists(branch)) {
            throw new Error(
                `Branch '${branch}' already exists. Adopt it as an existing branch, or choose another name.`,
            )
        }
    } else {
        const prefix = workspace().config.workPackageBranchPrefix
        const stem = workPackageBranchNameFor(
            workPackage.ref,
            workPackage.name,
            prefix,
        )
        branch = stem
        for (
            let suffix = siblings.length ? siblings.length + 1 : 2;
            findWorkPackageBranchByName(branch) || branchExists(branch);
            suffix++
        ) {
            branch = `${stem}-${suffix}`
        }
    }

    const base = input.baseBranch?.trim()
        ? validateBranchName(input.baseBranch)
        : null
    const members = listTasks({
        workPackageRef: workPackage.ref,
        includeClosed: true,
    })
    // Finished work that no other branch delivers belongs on this one too, or a
    // branch added after the work is done would start out with nothing on it.
    const onSibling = new Set(
        siblings.flatMap((one) => one.taskRefs.map((ref) => ref.toLowerCase())),
    )
    const taskRefs =
        input.taskRefs === undefined
            ? members
                  .filter(
                      (task) =>
                          task.status === "backlog" ||
                          task.status === "in_progress" ||
                          ((task.status === "dev_complete" ||
                              task.status === "verified") &&
                              !onSibling.has(task.ref.toLowerCase())),
                  )
                  .map((task) => task.ref)
            : input.taskRefs.map((ref) => memberRef(members, ref, workPackage))

    const at = nowIso()
    return getDb().transaction(() => {
        const row = getDb()
            .query<{ id: number }, Record<string, string | null>>(
                `INSERT INTO work_package_branches
               (work_package_ref, label, branch_name, base_branch, origin, created_at, updated_at)
             VALUES ($ref, $label, $branch, $base, $origin, $at, $at)
             RETURNING id`,
            )
            .get({
                $ref: workPackage.ref,
                $label: label,
                $branch: branch,
                $base: base,
                $origin: input.existing ? "existing" : "new",
                $at: at,
            })!
        insertBranchTasks(row.id, taskRefs)
        return requireWorkPackageBranch(row.id)
    })()
}

/** The canonical ref of `ref`, which has to be one of `members`. */
function memberRef(
    members: Task[],
    ref: string,
    workPackage: WorkPackage,
): string {
    const task = members.find(
        (one) => one.ref.toLowerCase() === ref.toLowerCase(),
    )
    if (!task) {
        requireTask(ref)
        throw new Error(
            `${ref} is not in ${workPackage.ref} (${workPackage.name}).`,
        )
    }
    return task.ref
}

export function updateWorkPackageBranch(
    id: number,
    input: { label?: string; branchName?: string; baseBranch?: string | null },
): WorkPackageBranch {
    const current = requireWorkPackageBranch(id)
    const assignments: string[] = []
    const params: Record<string, string | number | null> = {
        $id: current.id,
        $at: nowIso(),
    }

    if (input.label !== undefined) {
        const label = input.label.trim()
        if (!label) throw new Error("A branch tab needs a name.")
        assignments.push("label = $label")
        params.$label = label
    }
    if (input.baseBranch !== undefined) {
        assignments.push("base_branch = $base")
        params.$base = input.baseBranch?.trim()
            ? validateBranchName(input.baseBranch)
            : null
    }
    if (input.branchName !== undefined) {
        // A rename in Git as well as here, so the branch keeps its commits.
        const branch = validateBranchName(input.branchName)
        assertBranchUnclaimed(branch, current.id)
        if (branch !== current.branchName && branchExists(current.branchName)) {
            if (branchExists(branch)) {
                throw new Error(`Branch '${branch}' already exists locally.`)
            }
            if (findCombinedBranch(branch)) {
                throw new Error(
                    `A delivery record already exists for '${branch}'.`,
                )
            }
            renameBranch(current.branchName, branch)
            if (findCombinedBranch(current.branchName)) {
                renameCombinedBranch(current.branchName, branch)
            }
        }
        assignments.push("branch_name = $branch")
        params.$branch = branch
    }

    if (!assignments.length) return current
    getDb()
        .query(
            `UPDATE work_package_branches SET ${assignments.join(", ")}, updated_at = $at WHERE id = $id`,
        )
        .run(params)
    return requireWorkPackageBranch(current.id)
}

/** Forget a branch tab and its task assignments. The Git branch, and anything
 *  already merged into it, is left exactly where it is. */
export function deleteWorkPackageBranch(id: number): WorkPackageBranch {
    const branch = requireWorkPackageBranch(id)
    getDb()
        .query("DELETE FROM work_package_branches WHERE id = $id")
        .run({ $id: branch.id })
    return branch
}

/**
 * Make exactly `refs` the branch's tasks. Tasks it already had keep their
 * assignment row, so this never changes which of a task's branches counts as
 * its first.
 */
export function setBranchTasks(id: number, refs: string[]): WorkPackageBranch {
    const branch = requireWorkPackageBranch(id)
    const workPackage = requireWorkPackage(branch.workPackageRef)
    const members = listTasks({
        workPackageRef: workPackage.ref,
        includeClosed: true,
    })
    const wanted = refs.map((ref) => memberRef(members, ref, workPackage))
    const keep = new Set(wanted.map((ref) => ref.toLowerCase()))

    getDb().transaction(() => {
        const drop = getDb().query(
            "DELETE FROM branch_tasks WHERE branch_id = $id AND task_ref = $ref",
        )
        for (const ref of branch.taskRefs) {
            if (!keep.has(ref.toLowerCase()))
                drop.run({ $id: branch.id, $ref: ref })
        }
        insertBranchTasks(branch.id, wanted)
        getDb()
            .query(
                "UPDATE work_package_branches SET updated_at = $at WHERE id = $id",
            )
            .run({ $at: nowIso(), $id: branch.id })
    })()
    return requireWorkPackageBranch(branch.id)
}

/** Add to or take from a branch's tasks, leaving the rest alone. */
export function assignBranchTasks(
    id: number,
    refs: string[],
    remove = false,
): WorkPackageBranch {
    const branch = requireWorkPackageBranch(id)
    const drop = new Set(refs.map((ref) => requireTask(ref).ref.toLowerCase()))
    return setBranchTasks(
        branch.id,
        remove
            ? branch.taskRefs.filter((ref) => !drop.has(ref.toLowerCase()))
            : [...branch.taskRefs, ...refs],
    )
}

function insertBranchTasks(branchId: number, refs: string[]): void {
    const insert = getDb().query(
        `INSERT INTO branch_tasks (branch_id, task_ref, created_at)
         VALUES ($id, $ref, $at) ON CONFLICT(branch_id, task_ref) DO NOTHING`,
    )
    const at = nowIso()
    for (const ref of refs) insert.run({ $id: branchId, $ref: ref, $at: at })
}

/**
 * Where a task's own commits start on its first target branch — the exclusive
 * lower end of the range that is replayed onto its other target branches.
 * Null until the task has been merged into its first branch by this tool.
 */
export function ownCommitsFrom(ref: string): string | null {
    return (
        getDb()
            .query<{ own_commits_from: string | null }, { $ref: string }>(
                "SELECT own_commits_from FROM tasks WHERE ref = $ref COLLATE NOCASE",
            )
            .get({ $ref: ref })?.own_commits_from ?? null
    )
}

export function recordOwnCommitsFrom(ref: string, sha: string): void {
    getDb()
        .query(
            "UPDATE tasks SET own_commits_from = $sha WHERE ref = $ref COLLATE NOCASE",
        )
        .run({ $sha: sha, $ref: ref })
}

/* ----------------------------------------------------------- investigations */

interface InvestigationRow {
    id: number
    ref: string
    title: string
    brief: string
    findings: string
    status: string
    work_package_ref: string | null
    created_at: string
    updated_at: string
    started_at: string | null
    completed_at: string | null
}

function toInvestigation(row: InvestigationRow): Investigation {
    return {
        id: row.id,
        ref: row.ref,
        title: row.title,
        brief: row.brief,
        findings: row.findings,
        status: row.status as InvestigationStatus,
        workPackageRef: row.work_package_ref,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
    }
}

/** Timestamp column each investigation status stamps on entry. */
const INVESTIGATION_TIMESTAMP: Partial<Record<InvestigationStatus, string>> = {
    investigating: "started_at",
    complete: "completed_at",
}

export function listInvestigations(filter?: {
    status?: InvestigationStatus
    workPackageRef?: string
}): Investigation[] {
    const params: Record<string, string> = {}
    const clauses: string[] = []
    if (filter?.status) {
        clauses.push("status = $status")
        params.$status = filter.status
    }
    if (filter?.workPackageRef) {
        clauses.push("work_package_ref = $workPackage COLLATE NOCASE")
        params.$workPackage = requireWorkPackage(filter.workPackageRef).ref
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    return getDb()
        .query<InvestigationRow, typeof params>(
            `SELECT * FROM investigations ${where}
       ORDER BY CASE status
                  WHEN 'investigating' THEN 0
                  WHEN 'draft'         THEN 1
                  ELSE 2
                END,
                id DESC`,
        )
        .all(params)
        .map(toInvestigation)
}

export function findInvestigation(ref: string): Investigation | null {
    const row = getDb()
        .query<InvestigationRow, { $ref: string }>(
            "SELECT * FROM investigations WHERE ref = $ref COLLATE NOCASE",
        )
        .get({ $ref: ref })
    return row ? toInvestigation(row) : null
}

export function requireInvestigation(ref: string): Investigation {
    const investigation = findInvestigation(ref)
    if (!investigation) throw new Error(`No investigation with ref '${ref}'.`)
    return investigation
}

/** An investigation with the tasks it produced, closed ones included — a task
 *  taken all the way through is part of the answer. */
export function getInvestigationDetail(ref: string): InvestigationDetail {
    const investigation = requireInvestigation(ref)
    return {
        ...investigation,
        tasks: listTasks({
            investigationRef: investigation.ref,
            includeClosed: true,
        }),
    }
}

export function createInvestigation(input: {
    title: string
    brief?: string
    /** The work package whose tasks it files. */
    workPackageRef?: string | null
}): Investigation {
    const title = input.title.trim()
    if (!title) throw new Error("An investigation needs a title.")
    const workPackage = input.workPackageRef
        ? requireWorkPackage(input.workPackageRef).ref
        : null

    const at = nowIso()
    const ref = nextInvestigationRef()

    getDb()
        .query(
            `INSERT INTO investigations (ref, title, brief, findings, status, work_package_ref, created_at, updated_at)
       VALUES ($ref, $title, $brief, '', 'draft', $workPackage, $at, $at)`,
        )
        .run({
            $ref: ref,
            $title: title,
            $brief: input.brief ?? "",
            $workPackage: workPackage,
            $at: at,
        })

    return requireInvestigation(ref)
}

/** Partial update: only the keys present are written, so an agent saving its
 *  findings never overwrites a brief the human edited while it was thinking. */
export function updateInvestigation(
    ref: string,
    input: { title?: string; brief?: string; findings?: string },
): Investigation {
    const investigation = requireInvestigation(ref)

    const assignments: string[] = []
    const params: Record<string, string> = {
        $ref: investigation.ref,
        $at: nowIso(),
    }

    if (input.title !== undefined) {
        const title = input.title.trim()
        if (!title) throw new Error("An investigation needs a title.")
        assignments.push("title = $title")
        params.$title = title
    }
    if (input.brief !== undefined) {
        assignments.push("brief = $brief")
        params.$brief = input.brief
    }
    if (input.findings !== undefined) {
        assignments.push("findings = $findings")
        params.$findings = input.findings
    }

    if (!assignments.length) return investigation

    getDb()
        .query(
            `UPDATE investigations SET ${assignments.join(", ")}, updated_at = $at WHERE ref = $ref`,
        )
        .run(params)

    return requireInvestigation(investigation.ref)
}

export function setInvestigationStatus(
    ref: string,
    status: InvestigationStatus,
): Investigation {
    const investigation = requireInvestigation(ref)
    if (investigation.status === status) return investigation

    const stamp = INVESTIGATION_TIMESTAMP[status]
    const stampClause = stamp ? `, ${stamp} = $at` : ""

    getDb()
        .query(
            `UPDATE investigations SET status = $status, updated_at = $at${stampClause} WHERE ref = $ref`,
        )
        .run({ $status: status, $at: nowIso(), $ref: investigation.ref })

    return requireInvestigation(investigation.ref)
}

/** Deleting the question does not delete the answers: the tasks it filed stay,
 *  unlinked, because the work still needs doing. */
export function deleteInvestigation(ref: string): void {
    const investigation = requireInvestigation(ref)
    const db = getDb()
    db.query(
        "UPDATE tasks SET investigation_ref = NULL WHERE investigation_ref = $ref",
    ).run({ $ref: investigation.ref })
    db.query("DELETE FROM investigations WHERE id = $id").run({
        $id: investigation.id,
    })
}

/** Record that a task's work was included in a combined delivery branch. */
/** Correct a task's assigned branch when a legacy/generated name has since been
 * renamed in Git. Kept separate from ordinary task edits: branch assignment is
 * Git identity, not task metadata. */
export function updateTaskBranchName(ref: string, branchName: string): Task {
    const task = requireTask(ref)
    const at = nowIso()
    getDb()
        .query(
            "UPDATE tasks SET branch_name = $branch, use_git_workflow = 1, updated_at = $at WHERE ref = $ref",
        )
        .run({
            $branch: validateBranchName(branchName),
            $at: at,
            $ref: task.ref,
        })
    addEvent(task.id, "note", {
        note: `Assigned branch updated to '${branchName}'.`,
    })
    return requireTask(ref)
}

/**
 * Note on a task that its work now lives on a delivery branch.
 *
 * A branch built from one task alone is "prepared" rather than "combined", and
 * gets its own wording. Only the combined phrasing is parsed anywhere (the
 * legacy backfill in `db.ts`), and that parse only matters for delivery
 * branches predating the `combined_branches` table — so it stays untouched.
 */
export function recordCombinedBranch(
    ref: string,
    branchName: string,
    combined = true,
): void {
    addNote(
        ref,
        combined
            ? `Included in combined branch '${branchName}'.`
            : `Prepared as delivery branch '${branchName}'.`,
    )
}

/* ----------------------------------------------------- combined branches */

/** A stored report that no longer parses is treated as no report at all —
 *  a branch without checks is a branch that has to run them, which is the safe
 *  reading. */
function parseChecks(raw: string | null): ChecksReport | null {
    if (!raw) return null
    try {
        const parsed: unknown = JSON.parse(raw)
        return parsed && typeof parsed === "object"
            ? (parsed as ChecksReport)
            : null
    } catch {
        return null
    }
}

interface CombinedBranchRow {
    id: number
    branch_name: string
    base_branch: string | null
    remote_branch: string | null
    task_refs: string
    pr_title: string | null
    pr_body: string | null
    pr_url: string | null
    pr_number: number | null
    combine_state: "complete" | "conflict"
    combine_pending_commits: string
    combine_close_tasks: number
    checks_json: string | null
    created_at: string
    updated_at: string
}

function toCombinedBranch(row: CombinedBranchRow): CombinedBranch {
    let taskRefs: string[] = []
    let combinePendingCommits: string[] = []
    try {
        const parsed: unknown = JSON.parse(row.task_refs)
        if (Array.isArray(parsed)) taskRefs = parsed.map(String)
        const pending: unknown = JSON.parse(row.combine_pending_commits)
        if (Array.isArray(pending)) combinePendingCommits = pending.map(String)
    } catch {
        // A hand-edited row should not take the whole list down with it.
    }

    return {
        id: row.id,
        branchName: row.branch_name,
        baseBranch: row.base_branch,
        remoteBranch: row.remote_branch,
        taskRefs,
        prTitle: row.pr_title,
        prBody: row.pr_body,
        prUrl: row.pr_url,
        prNumber: row.pr_number,
        combineState: row.combine_state,
        combinePendingCommits,
        combineCloseTasks: Boolean(row.combine_close_tasks),
        checks: parseChecks(row.checks_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

export function listCombinedBranches(): CombinedBranch[] {
    return getDb()
        .query<CombinedBranchRow, []>(
            "SELECT * FROM combined_branches ORDER BY id DESC",
        )
        .all()
        .map(toCombinedBranch)
}

export function findCombinedBranch(branchName: string): CombinedBranch | null {
    const row = getDb()
        .query<CombinedBranchRow, { $name: string }>(
            "SELECT * FROM combined_branches WHERE branch_name = $name",
        )
        .get({ $name: branchName })

    return row ? toCombinedBranch(row) : null
}

export function requireCombinedBranch(branchName: string): CombinedBranch {
    const branch = findCombinedBranch(branchName)
    if (!branch) throw new Error(`No combined branch named '${branchName}'.`)
    return branch
}

/** Called once a combine's Git work has fully succeeded. */
export function recordCombine(input: {
    branchName: string
    baseBranch: string | null
    taskRefs: string[]
    combineState?: "complete" | "conflict"
    combinePendingCommits?: string[]
    combineCloseTasks?: boolean
}): CombinedBranch {
    const at = nowIso()
    getDb()
        .query(
            `INSERT INTO combined_branches (branch_name, base_branch, task_refs, combine_state, combine_pending_commits, combine_close_tasks, created_at, updated_at)
       VALUES ($name, $base, $refs, $state, $pending, $closeTasks, $at, $at)
       ON CONFLICT(branch_name) DO UPDATE
         SET base_branch = $base, task_refs = $refs, combine_state = $state, combine_pending_commits = $pending, combine_close_tasks = $closeTasks, updated_at = $at`,
        )
        .run({
            $name: input.branchName,
            $base: input.baseBranch,
            $refs: JSON.stringify(input.taskRefs),
            $state: input.combineState ?? "complete",
            $pending: JSON.stringify(input.combinePendingCommits ?? []),
            $closeTasks: input.combineCloseTasks ? 1 : 0,
            $at: at,
        })

    return requireCombinedBranch(input.branchName)
}

/**
 * Add one task to a delivery branch's roster, keeping everything else about the
 * branch as it was.
 *
 * This is how a work package branch accumulates its tasks: each `tasks done` merge
 * registers the task it just merged, so the branch's record answers "what is on
 * this branch" without anyone having to select the tasks by hand. Idempotent —
 * re-registering a task already on the roster changes nothing, which is what
 * makes re-running a merge safe.
 */
export function registerTaskOnBranch(
    branchName: string,
    taskRef: string,
    baseBranch: string | null,
): CombinedBranch {
    const task = requireTask(taskRef)
    const existing = findCombinedBranch(branchName)
    const refs = existing ? [...existing.taskRefs] : []
    if (!refs.includes(task.ref)) refs.push(task.ref)

    return recordCombine({
        branchName,
        // An existing record's base is left alone: it was set when the branch was
        // built and is what its PR is against.
        baseBranch: existing?.baseBranch ?? baseBranch,
        taskRefs: refs,
        combineState: existing?.combineState,
        combinePendingCommits: existing?.combinePendingCommits,
        combineCloseTasks: existing?.combineCloseTasks,
    })
}

/** Take one task off a delivery branch's roster — the reverse of
 *  `registerTaskOnBranch`, once its commits have been taken off the branch. */
export function unregisterTaskFromBranch(
    branchName: string,
    taskRef: string,
): void {
    const existing = findCombinedBranch(branchName)
    if (!existing) return
    const refs = existing.taskRefs.filter(
        (one) => one.toLowerCase() !== taskRef.toLowerCase(),
    )
    if (refs.length === existing.taskRefs.length) return
    recordCombine({
        branchName,
        baseBranch: existing.baseBranch,
        taskRefs: refs,
        combineState: existing.combineState,
        combinePendingCommits: existing.combinePendingCommits,
        combineCloseTasks: existing.combineCloseTasks,
    })
}

/** Partial update. Only the keys present are written, so saving a description
 *  never clears a PR url recorded by a different request. */
export function updateCombinedBranch(
    branchName: string,
    input: {
        baseBranch?: string | null
        remoteBranch?: string | null
        prTitle?: string | null
        prBody?: string | null
        prUrl?: string | null
        prNumber?: number | null
        combineState?: "complete" | "conflict"
        checks?: ChecksReport | null
    },
): CombinedBranch {
    requireCombinedBranch(branchName)

    const columns = {
        baseBranch: "base_branch",
        remoteBranch: "remote_branch",
        prTitle: "pr_title",
        prBody: "pr_body",
        prUrl: "pr_url",
        prNumber: "pr_number",
        combineState: "combine_state",
    } as const

    const assignments: string[] = []
    const params: Record<string, string | number | null> = {
        $name: branchName,
        $at: nowIso(),
    }

    for (const [key, column] of Object.entries(columns)) {
        const value = input[key as keyof typeof input]
        if (value === undefined) continue
        assignments.push(`${column} = $${key}`)
        params[`$${key}`] = value as string | number | null
    }

    if (input.checks !== undefined) {
        assignments.push("checks_json = $checks")
        params.$checks =
            input.checks === null ? null : JSON.stringify(input.checks)
    }

    if (assignments.length) {
        getDb()
            .query(
                `UPDATE combined_branches SET ${assignments.join(", ")}, updated_at = $at
          WHERE branch_name = $name`,
            )
            .run(params)
    }

    return requireCombinedBranch(branchName)
}

/** Rename the persisted delivery-branch record after Git has renamed the ref. */
export function renameCombinedBranch(
    branchName: string,
    newBranchName: string,
): CombinedBranch {
    requireCombinedBranch(branchName)
    const name = validateBranchName(newBranchName)
    if (name === branchName) return requireCombinedBranch(branchName)
    getDb()
        .query(
            "UPDATE combined_branches SET branch_name = $newName, updated_at = $at WHERE branch_name = $name",
        )
        .run({ $newName: name, $name: branchName, $at: nowIso() })
    return requireCombinedBranch(name)
}

export function deleteCombinedBranch(branchName: string): void {
    requireCombinedBranch(branchName)
    getDb()
        .query("DELETE FROM combined_branches WHERE branch_name = $name")
        .run({ $name: branchName })
}

/* ----------------------------------------------------- checkpoint records */

export interface RecordRunInput {
    taskId: number
    checkpointName: string
    phase: Phase
    exitCode: number
    gitHead: string | null
    gitDirty: boolean | null
    scenarioCount: number
    selection: { scenarios?: string[]; folders?: string[] } | null
    raw: unknown
    comparisons: Omit<Comparison, "id" | "runId">[]
}

export function recordRun(input: RecordRunInput): number {
    const db = getDb()

    const insert = db.transaction((run: RecordRunInput) => {
        const row = db
            .query<{ id: number }, Record<string, string | number | null>>(
                `INSERT INTO checkpoint_runs (task_id, checkpoint_name, phase, exit_code,
                                      git_head, git_dirty, scenario_count, raw_json,
                                      selection_json, created_at)
         VALUES ($task, $name, $phase, $exit, $head, $dirty, $count, $raw, $selection, $at)
         RETURNING id`,
            )
            .get({
                $task: run.taskId,
                $name: run.checkpointName,
                $phase: run.phase,
                $exit: run.exitCode,
                $head: run.gitHead,
                $dirty: run.gitDirty === null ? null : run.gitDirty ? 1 : 0,
                $count: run.scenarioCount,
                $raw: run.raw === undefined ? null : JSON.stringify(run.raw),
                $selection: run.selection
                    ? JSON.stringify(run.selection)
                    : null,
                $at: nowIso(),
            })

        const runId = row!.id
        const statement = db.query(
            `INSERT INTO checkpoint_comparisons (run_id, scenario, description, status,
              percent_changed, pixel_diff_count, total_pixels,
              before_path, after_path, diff_path,
              browser_log_status, browser_log_change_count)
       VALUES ($run, $scenario, $description, $status,
               $percent, $pixels, $total,
               $before, $after, $diff,
               $logStatus, $logCount)`,
        )

        for (const comparison of run.comparisons) {
            statement.run({
                $run: runId,
                $scenario: comparison.scenario,
                $description: comparison.description,
                $status: comparison.status,
                $percent: comparison.percentChanged,
                $pixels: comparison.pixelDiffCount,
                $total: comparison.totalPixels,
                $before: comparison.beforePath,
                $after: comparison.afterPath,
                $diff: comparison.diffPath,
                $logStatus: comparison.browserLogStatus,
                $logCount: comparison.browserLogChangeCount,
            })
        }

        return runId
    })

    const runId = insert(input)
    addEvent(input.taskId, "checkpoint", {
        note: `${input.phase} checkpoint '${input.checkpointName}' — ${input.scenarioCount} scenario(s)`,
    })
    return runId
}

/** Most recent run of a phase, used to tell whether `before` was ever captured. */
export function latestRun(taskId: number, phase: Phase): CheckpointRun | null {
    const runs = listRuns(taskId).filter((run) => run.phase === phase)
    return runs.length ? runs[runs.length - 1]! : null
}

/**
 * Oldest run of a phase. A `before` may have been captured more than once, and
 * it is the first one that says which commit the task's starting state was —
 * a later re-capture was taken from that same point deliberately.
 */
export function firstRun(taskId: number, phase: Phase): CheckpointRun | null {
    return listRuns(taskId).find((run) => run.phase === phase) ?? null
}

/* ------------------------------------------------------------ work package runs */

/**
 * The rows behind an unattended work package run.
 *
 * Only the storage lives here, with the rest of the data layer. The loop itself
 * — what counts as a task being done, what stops it, what it starts next — is
 * in `workPackageRuns.ts`, which is the only thing that writes these beyond a read.
 */

interface WorkPackageRunRow {
    id: number
    work_package_ref: string
    harness: string
    model: string
    permission_mode: string
    extra: string
    status: string
    current_run_id: number | null
    current_ref: string | null
    worked_json: string
    excluded_json: string
    run_ids_json: string
    supervisor_json: string | null
    resumed_at: string | null
    stop_reason: string
    created_at: string
    finished_at: string | null
}

function toWorkPackageRun(row: WorkPackageRunRow): WorkPackageRun {
    return {
        id: row.id,
        workPackageRef: row.work_package_ref,
        harness: row.harness as AgentHarnessId,
        model: row.model,
        permissionMode: row.permission_mode as AgentPermissionMode,
        extra: row.extra,
        status: row.status as WorkPackageRunStatus,
        currentRunId: row.current_run_id,
        currentRef: row.current_ref,
        worked: JSON.parse(row.worked_json) as string[],
        excluded: JSON.parse(row.excluded_json) as string[],
        runIds: JSON.parse(row.run_ids_json) as number[],
        supervisor: row.supervisor_json
            ? (JSON.parse(row.supervisor_json) as RunSupervisor)
            : null,
        stopReason: row.stop_reason,
        createdAt: row.created_at,
        resumedAt: row.resumed_at,
        finishedAt: row.finished_at,
    }
}

/**
 * The work package's most recent run, whatever became of it.
 *
 * Deliberately not filtered to running ones. A finished loop is what the page
 * has to draw after the last task lands, and a stopped one is the only place
 * the reason it stopped is written down.
 */
export function latestWorkPackageRun(
    workPackageRef: string,
): WorkPackageRun | null {
    const row = getDb()
        .query<WorkPackageRunRow, { $ref: string }>(
            "SELECT * FROM work_package_runs WHERE work_package_ref = $ref COLLATE NOCASE ORDER BY id DESC LIMIT 1",
        )
        .get({ $ref: workPackageRef })
    return row ? toWorkPackageRun(row) : null
}

export function listWorkPackageRuns(
    workPackageRef?: string,
    limit = 20,
): WorkPackageRun[] {
    const db = getDb()
    const rows = workPackageRef
        ? db
              .query<WorkPackageRunRow, { $ref: string; $limit: number }>(
                  "SELECT * FROM work_package_runs WHERE work_package_ref = $ref COLLATE NOCASE ORDER BY id DESC LIMIT $limit",
              )
              .all({ $ref: workPackageRef, $limit: limit })
        : db
              .query<WorkPackageRunRow, { $limit: number }>(
                  "SELECT * FROM work_package_runs ORDER BY id DESC LIMIT $limit",
              )
              .all({ $limit: limit })
    return rows.map(toWorkPackageRun)
}

export function findWorkPackageRun(id: number): WorkPackageRun | null {
    const row = getDb()
        .query<WorkPackageRunRow, { $id: number }>(
            "SELECT * FROM work_package_runs WHERE id = $id",
        )
        .get({ $id: id })
    return row ? toWorkPackageRun(row) : null
}

export function requireWorkPackageRun(id: number): WorkPackageRun {
    const found = findWorkPackageRun(id)
    if (!found) throw new Error(`No work package run with id ${id}.`)
    return found
}

/** Every loop that still believes it is working. Used to keep two from owning
 *  the same work package, and to settle them all when the server restarts. */
export function runningWorkPackageRuns(): WorkPackageRun[] {
    return getDb()
        .query<WorkPackageRunRow, []>(
            "SELECT * FROM work_package_runs WHERE status = 'running' ORDER BY id",
        )
        .all()
        .map(toWorkPackageRun)
}

/** The loop currently working `agentRunId`, if a loop launched it at all. */
export function workPackageRunForAgentRun(
    agentRunId: number,
): WorkPackageRun | null {
    const row = getDb()
        .query<WorkPackageRunRow, { $id: number }>(
            "SELECT * FROM work_package_runs WHERE current_run_id = $id AND status = 'running' LIMIT 1",
        )
        .get({ $id: agentRunId })
    return row ? toWorkPackageRun(row) : null
}

export function createWorkPackageRun(input: {
    workPackageRef: string
    harness: AgentHarnessId
    model: string
    permissionMode: AgentPermissionMode
    extra: string
    excluded: string[]
    supervisor?: RunSupervisor | null
}): WorkPackageRun {
    const row = getDb()
        .query<{ id: number }, Record<string, string | null>>(
            `INSERT INTO work_package_runs
         (work_package_ref, harness, model, permission_mode, extra, status, worked_json, excluded_json,
          supervisor_json, created_at)
       VALUES ($ref, $harness, $model, $permission, $extra, 'running', '[]', $excluded, $supervisor, $at)
       RETURNING id`,
        )
        .get({
            $ref: input.workPackageRef,
            $harness: input.harness,
            $model: input.model,
            $permission: input.permissionMode,
            $extra: input.extra,
            $excluded: JSON.stringify(input.excluded),
            $supervisor: input.supervisor
                ? JSON.stringify(input.supervisor)
                : null,
            $at: nowIso(),
        })!

    return requireWorkPackageRun(row.id)
}

/** Point the loop at the task it has just launched, and remember the launch. */
export function setWorkPackageRunCurrent(
    id: number,
    agentRunId: number,
    ref: string,
): WorkPackageRun {
    const run = requireWorkPackageRun(id)
    getDb()
        .query(
            "UPDATE work_package_runs SET current_run_id = $run, current_ref = $ref, run_ids_json = $runs WHERE id = $id",
        )
        .run({
            $id: id,
            $run: agentRunId,
            $ref: ref,
            $runs: JSON.stringify([...run.runIds, agentRunId]),
        })
    return requireWorkPackageRun(id)
}

/** Record a task as carried all the way to Dev Complete by this loop. */
export function recordWorkPackageRunWorked(
    id: number,
    ref: string,
): WorkPackageRun {
    const run = requireWorkPackageRun(id)
    if (run.worked.includes(ref)) return run

    getDb()
        .query(
            "UPDATE work_package_runs SET worked_json = $worked WHERE id = $id",
        )
        .run({ $id: id, $worked: JSON.stringify([...run.worked, ref]) })
    return requireWorkPackageRun(id)
}

/** Give a loop a supervisor, swap it for another, or take it away. The loop
 *  reads it afresh each time a task stops short, so this applies from the next
 *  stop on, whether the loop is running or not. */
export function setWorkPackageRunSupervisor(
    id: number,
    supervisor: RunSupervisor | null,
): WorkPackageRun {
    requireWorkPackageRun(id)
    getDb()
        .query(
            "UPDATE work_package_runs SET supervisor_json = $supervisor WHERE id = $id",
        )
        .run({
            $id: id,
            $supervisor: supervisor ? JSON.stringify(supervisor) : null,
        })
    return requireWorkPackageRun(id)
}

/**
 * Set a settled loop running again, keeping what it already worked. `runIds`
 * replaces the recorded launches, for a loop from before they were recorded.
 * Refused unless the loop has settled, so two resumes cannot both win.
 */
export function reopenWorkPackageRun(
    id: number,
    runIds: number[],
): WorkPackageRun {
    const reopened = getDb()
        .query(
            `UPDATE work_package_runs SET status = 'running', stop_reason = '', finished_at = NULL,
                run_ids_json = $runs, resumed_at = $at
        WHERE id = $id AND status != 'running'`,
        )
        .run({ $id: id, $runs: JSON.stringify(runIds), $at: nowIso() })
    if (!reopened.changes)
        throw new Error(`Work package run ${id} is already running.`)
    return requireWorkPackageRun(id)
}

/** Settle a loop. `running` is the one status this cannot set — a loop that has
 *  stopped stays stopped until `reopenWorkPackageRun` is asked for by name. */
export function settleWorkPackageRun(
    id: number,
    status: WorkPackageRunStatus,
    stopReason: string,
): WorkPackageRun {
    if (status === "running")
        throw new Error(
            "A work package run cannot be settled as still running.",
        )
    getDb()
        .query(
            `UPDATE work_package_runs SET status = $status, stop_reason = $reason, finished_at = $at
        WHERE id = $id AND status = 'running'`,
        )
        .run({ $id: id, $status: status, $reason: stopReason, $at: nowIso() })
    return requireWorkPackageRun(id)
}
