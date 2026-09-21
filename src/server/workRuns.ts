import { getDb, nowIso } from "./db"
import { findAgentRun, startRun, stopRun } from "./agents"
import { findTask, findWorkPackageRun, requireWorkPackage } from "./repo"
import { getWorkPackageDetail } from "./workPackageBranch"
import {
    resumeWorkPackageRun,
    setSupervisor,
    startWorkPackageRun,
    stopWorkPackageRun,
} from "./workPackageRuns"
import {
    nextWorkableTask,
    satisfiesDependency,
    WORK_RUN_KINDS,
    type AgentHarnessId,
    type AgentPermissionMode,
    type AgentRun,
    type AgentRunMode,
    type RunSupervisor,
    type WorkPackageRun,
    type WorkRun,
    type WorkRunAgent,
    type WorkRunDetail,
    type WorkRunItem,
    type WorkRunKind,
    type WorkRunStatus,
} from "../shared/types"

/**
 * Run tabs: an agent put to work on a work package, remembered on its page.
 *
 * Launching is delegated whole to what already exists — `startRun` for one
 * agent, `startWorkPackageRun` for the unattended loop. What this adds is the
 * record tying a launch to its work package and to the tasks it set out to do,
 * which is what lets the tab show those tasks being worked through.
 */

interface WorkRunRow {
    id: number
    work_package_ref: string
    label: string
    kind: string
    harness: string
    model: string
    mode: string
    permission_mode: string
    extra: string
    task_refs_json: string
    agent_run_id: number | null
    work_package_run_id: number | null
    created_at: string
    updated_at: string
}

function toWorkRun(row: WorkRunRow): WorkRun {
    return {
        id: row.id,
        workPackageRef: row.work_package_ref,
        label: row.label,
        kind: row.kind as WorkRunKind,
        harness: row.harness as AgentHarnessId,
        model: row.model,
        mode: row.mode as AgentRunMode,
        permissionMode: row.permission_mode as AgentPermissionMode,
        extra: row.extra,
        taskRefs: JSON.parse(row.task_refs_json) as string[],
        agentRunId: row.agent_run_id,
        workPackageRunId: row.work_package_run_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

export function listWorkRuns(workPackageRef: string): WorkRun[] {
    return getDb()
        .query<WorkRunRow, { $ref: string }>(
            "SELECT * FROM work_runs WHERE work_package_ref = $ref COLLATE NOCASE ORDER BY id",
        )
        .all({ $ref: workPackageRef })
        .map(toWorkRun)
}

export function requireWorkRun(id: number): WorkRun {
    const row = getDb()
        .query<WorkRunRow, { $id: number }>(
            "SELECT * FROM work_runs WHERE id = $id",
        )
        .get({ $id: id })
    if (!row) throw new Error(`No run with id ${id}.`)
    return toWorkRun(row)
}

export interface StartWorkRunInput {
    workPackageRef: string
    kind: WorkRunKind
    label?: string
    harness: string
    model: string
    mode: AgentRunMode
    permissionMode: AgentPermissionMode
    extra: string
    /** Unattended runs only: who to call in when a task stops short. */
    supervisor?: RunSupervisor | null
}

/** Launch the agent a run describes, and record the run as a tab. */
export function startWorkRun(input: StartWorkRunInput): WorkRunDetail {
    if (!WORK_RUN_KINDS.includes(input.kind))
        throw new Error(`Unknown run kind '${input.kind}'.`)
    const workPackage = requireWorkPackage(input.workPackageRef)
    const detail = getWorkPackageDetail(workPackage.ref)

    let taskRefs: string[]
    let agentRunId: number | null = null
    let workPackageRunId: number | null = null
    let mode = input.mode
    let permissionMode = input.permissionMode
    let label = input.label?.trim() ?? ""

    if (input.kind === "unattended") {
        // Nobody is at a terminal for any of these agents, so the only mode
        // that can finish is headless, and the only permission mode that can
        // finish is the one that never asks.
        mode = "print"
        if (permissionMode === "manual") permissionMode = "bypassPermissions"
        const started = startWorkPackageRun({
            workPackageRef: workPackage.ref,
            harness: input.harness,
            model: input.model,
            permissionMode,
            extra: input.extra,
            excluded: [],
            supervisor: input.supervisor,
        })
        workPackageRunId = started.workPackageRun.id
        agentRunId = started.run.id
        taskRefs = detail.queue.map((task) => task.ref)
        label ||= "Unattended run"
    } else if (input.kind === "next-task") {
        const next = nextWorkableTask(detail)
        if (!next) throw new Error("There is no task ready to work.")
        agentRunId = startRun({
            harness: input.harness,
            model: input.model,
            mode,
            command: "work-task",
            target: next.ref,
            extra: input.extra,
            subjectKind: "task",
            subjectRef: next.ref,
            permissionMode,
        }).id
        taskRefs = [next.ref]
        label ||= `Work ${next.ref}`
    } else {
        if (!detail.queue.length)
            throw new Error("There are no unfinished tasks to work.")
        agentRunId = startRun({
            harness: input.harness,
            model: input.model,
            mode,
            command: "work-package",
            target: workPackage.ref,
            extra: input.extra,
            subjectKind: "work-package",
            subjectRef: workPackage.ref,
            permissionMode,
        }).id
        taskRefs = detail.queue.map((task) => task.ref)
        label ||= "Guided run"
    }

    const at = nowIso()
    const row = getDb()
        .query<{ id: number }, Record<string, string | number | null>>(
            `INSERT INTO work_runs (work_package_ref, label, kind, harness, model, mode, permission_mode,
                                extra, task_refs_json, agent_run_id, work_package_run_id, created_at, updated_at)
         VALUES ($ref, $label, $kind, $harness, $model, $mode, $permission, $extra, $tasks,
                 $agentRun, $packageRun, $at, $at)
         RETURNING id`,
        )
        .get({
            $ref: workPackage.ref,
            $label: label,
            $kind: input.kind,
            $harness: input.harness,
            $model: input.model,
            $mode: mode,
            $permission: permissionMode,
            $extra: input.extra,
            $tasks: JSON.stringify(taskRefs),
            $agentRun: agentRunId,
            $packageRun: workPackageRunId,
            $at: at,
        })!
    return workRunDetail(requireWorkRun(row.id))
}

export function renameWorkRun(id: number, label: string): WorkRun {
    const run = requireWorkRun(id)
    const name = label.trim()
    if (!name) throw new Error("A run tab needs a name.")
    getDb()
        .query(
            "UPDATE work_runs SET label = $label, updated_at = $at WHERE id = $id",
        )
        .run({ $label: name, $at: nowIso(), $id: run.id })
    return requireWorkRun(run.id)
}

/** Forget the tab. A run still going is not stopped by this — refused instead. */
export function deleteWorkRun(id: number): void {
    const run = workRunDetail(requireWorkRun(id))
    if (run.status === "running")
        throw new Error("Stop the run before removing its tab.")
    getDb().query("DELETE FROM work_runs WHERE id = $id").run({ $id: id })
}

export function stopWorkRun(id: number): WorkRunDetail {
    const run = requireWorkRun(id)
    if (run.workPackageRunId !== null) stopWorkPackageRun(run.workPackageRunId)
    else if (run.agentRunId !== null) stopRun(run.agentRunId)
    return workRunDetail(requireWorkRun(id))
}

/**
 * Set an unattended run going again from where it stopped. Tasks added to the
 * work package since it started join the end of the tab's list, since the loop
 * will work them too.
 */
export function resumeWorkRun(id: number): WorkRunDetail {
    const run = requireWorkRun(id)
    const loop =
        run.workPackageRunId !== null
            ? findWorkPackageRun(run.workPackageRunId)
            : null
    if (run.kind !== "unattended" || !loop)
        throw new Error(
            "Only an unattended run can be resumed from its tab. Reopen this one's conversation in a terminal instead.",
        )

    resumeWorkPackageRun(
        loop.id,
        loop.runIds.length ? loop.runIds : legacyLoopRunIds(run, loop),
    )

    const known = new Set(run.taskRefs.map((ref) => ref.toLowerCase()))
    const added = getWorkPackageDetail(run.workPackageRef)
        .queue.map((task) => task.ref)
        .filter((ref) => !known.has(ref.toLowerCase()))
    getDb()
        .query(
            "UPDATE work_runs SET task_refs_json = $tasks, updated_at = $at WHERE id = $id",
        )
        .run({
            $id: run.id,
            $tasks: JSON.stringify([...run.taskRefs, ...added]),
            $at: nowIso(),
        })
    return workRunDetail(requireWorkRun(id))
}

/** Attach, change or remove an unattended run's supervisor. */
export function setWorkRunSupervisor(
    id: number,
    supervisor: RunSupervisor | null,
): WorkRunDetail {
    const run = requireWorkRun(id)
    if (run.kind !== "unattended" || run.workPackageRunId === null)
        throw new Error("Only an unattended run can have a supervisor.")
    setSupervisor(run.workPackageRunId, supervisor)
    return workRunDetail(requireWorkRun(id))
}

const AGENT_STATUS: Record<AgentRun["status"], WorkRunStatus> = {
    launched: "launched",
    running: "running",
    succeeded: "finished",
    failed: "failed",
    stopped: "stopped",
}

/** The run as its tab draws it: its state, and where each task stands. */
export function workRunDetail(run: WorkRun): WorkRunDetail {
    const loop =
        run.workPackageRunId !== null
            ? findWorkPackageRun(run.workPackageRunId)
            : null
    const agentRun = findAgentRun(loop?.currentRunId ?? run.agentRunId ?? -1)

    const status: WorkRunStatus = loop
        ? loop.status
        : agentRun
          ? AGENT_STATUS[agentRun.status]
          : "failed"
    const statusDetail = loop
        ? loop.stopReason
        : agentRun
          ? ""
          : "The agent's record is missing."
    const current =
        loop?.status === "running" ? loop.currentRef?.toLowerCase() : null
    const agents = headlessAgentsByTask(run, loop)

    const items: WorkRunItem[] = run.taskRefs.map((ref) => {
        const task = findTask(ref)
        const state: WorkRunItem["state"] =
            task && satisfiesDependency(task.status)
                ? "done"
                : task?.status === "in_progress" ||
                    ref.toLowerCase() === current
                  ? "working"
                  : "waiting"
        return {
            ref: task?.ref ?? ref,
            title: task?.title ?? "(deleted)",
            status: task?.status ?? null,
            state,
            agents: agents.get(ref.toLowerCase()) ?? [],
        }
    })

    return {
        ...run,
        status,
        statusDetail,
        items,
        supervisor: loop?.supervisor ?? null,
        agentRun,
    }
}

/**
 * The headless agents a run launched, grouped by the task each was pointed at.
 *
 * Only headless ones, because only they leave a log behind — a terminal run's
 * output belongs to its window. A guided run is one agent across every task,
 * so it has nothing to file under any one of them.
 */
function headlessAgentsByTask(
    run: WorkRun,
    loop: WorkPackageRun | null,
): Map<string, WorkRunAgent[]> {
    const ids = loop
        ? loop.runIds.length
            ? loop.runIds
            : legacyLoopRunIds(run, loop)
        : run.kind === "next-task" && run.agentRunId !== null
          ? [run.agentRunId]
          : []

    const byTask = new Map<string, WorkRunAgent[]>()
    for (const id of ids) {
        const agent = findAgentRun(id)
        if (!agent || agent.mode !== "print" || agent.subjectKind !== "task")
            continue
        const key = agent.subjectRef.toLowerCase()
        byTask.set(key, [
            ...(byTask.get(key) ?? []),
            {
                id: agent.id,
                command: agent.command,
                status: agent.status,
                exitCode: agent.exitCode,
                createdAt: agent.createdAt,
                finishedAt: agent.finishedAt,
            },
        ])
    }
    return byTask
}

/**
 * A loop from before each launch was recorded remembers only its first agent
 * (on the tab) and its last (on the loop). Only one loop runs at a time, so
 * the `/work-task` runs between the two are its own, give or take one started
 * by hand alongside it.
 */
function legacyLoopRunIds(run: WorkRun, loop: WorkPackageRun): number[] {
    if (run.agentRunId === null || loop.currentRunId === null) return []
    return getDb()
        .query<{ id: number }, { $first: number; $last: number }>(
            `SELECT id FROM agent_runs
             WHERE id BETWEEN $first AND $last AND command = 'work-task' AND mode = 'print'
             ORDER BY id`,
        )
        .all({ $first: run.agentRunId, $last: loop.currentRunId })
        .map((row) => row.id)
}
