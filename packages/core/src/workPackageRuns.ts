import {
    findAgentRun,
    unattendedSupervisor,
    onRunSettled,
    runResult,
    runUsageLimit,
    runTrail,
    startRun,
    stopRun,
    supervisorVerdict,
} from "./agents"
import { getWorkPackageDetail, missingTargets } from "./workPackageBranch"
import {
    createWorkPackageRun,
    findTask,
    reopenWorkPackageRun,
    workPackageRunForAgentRun,
    latestWorkPackageRun,
    recordWorkPackageRunWorked,
    requireWorkPackage,
    requireWorkPackageRun,
    runningWorkPackageRuns,
    setWorkPackageRunCurrent,
    setWorkPackageRunSupervisor,
    settleWorkPackageRun,
} from "./repo"
import {
    MAX_SUPERVISIONS_PER_TASK,
    RECOMMENDED_MODEL,
    workPackageRunActive,
    nextWorkableTask,
    type AgentPermissionMode,
    type AgentRun,
    type AgentRunStatus,
    type RunSupervisor,
    type Task,
    type WorkPackageRun,
    type WorkPackageDetail,
} from "@work-task-manager/shared"
import { workspace } from "./config/paths"

/**
 * Working a whole work package unattended, one fresh agent per task.
 *
 * The problem this solves is context, not clicking. `/work-package` already
 * walks a work package's queue, but it does it inside a single conversation, so by the
 * fifth task the agent is carrying four tasks' worth of transcript that has
 * nothing to do with the fifth. This is the same loop turned inside out: the
 * order lives here, and each task gets its own headless `/work-task` process
 * starting from nothing.
 *
 * ## Knowing when a task is finished
 *
 * Two signals, and both have to agree.
 *
 * The **process exiting** is the timing. That is observed rather than inferred
 * because these agents are children of this server — no polling interval to
 * tune, no hook to install, and no window where a second agent could be
 * launched on top of one still working.
 *
 * The **task reaching `dev_complete`** is the verdict. Exit code alone will not
 * do: `claude -p` exits 0 whenever it stops for a good reason, and `/work-task`
 * lists five of those — a merge conflict, a checkpoint failure, a decision the
 * user has not made, a branch cut from somewhere unexpected, anything needing a
 * force-push. All of them look exactly like success from outside. So the
 * database is asked what actually happened, and a run that exits cleanly having
 * moved nothing stops the loop rather than rolling the work package forward past a
 * task nobody finished.
 *
 * ## Stopping
 *
 * Everything here fails towards stopping. A task that did not complete, a queue
 * that stopped shrinking, a task in flight that this loop did not start, a
 * server restart — each settles the run and leaves what was already merged
 * exactly where it is. A partly delivered work package is the normal recoverable
 * state, and the run's `stopReason` is what tells the user which of these it
 * was.
 *
 * Interactive runs are not offered. A terminal run's pid belongs to the
 * emulator rather than to the agent, so there is nothing here to wait on; and
 * an agent that can ask questions holds the whole queue until somebody answers.
 */

/**
 * A ceiling on how many tasks one run will work, whatever else happens.
 *
 * The real guard against looping forever is `worked` — a ref that comes back
 * around after being finished stops the run — so this is the backstop for a
 * failure nobody has thought of yet, not the mechanism.
 */
const MAX_TASKS_PER_RUN = 50

/* ------------------------------------------------------------- launching */

export interface StartWorkPackageRunInput {
    workPackageRef: string
    harness: string
    model: string
    permissionMode: AgentPermissionMode
    /** Extra prompt text appended to every task in the loop, not just the first. */
    extra: string
    /** Unfinished tasks the user chose to leave out of this run. */
    excluded: string[]
    /** Only work these tasks. Absent allows newly added tasks. */
    selected?: string[]
    /** Who to call in when a task stops short, if anyone. */
    supervisor?: RunSupervisor | null
    fallback?: "stop" | "codex"
}

function includedTasks(
    detail: WorkPackageDetail,
    excluded: readonly string[],
    selected?: readonly string[] | null,
) {
    const omitted = new Set(excluded.map((ref) => ref.toLowerCase()))
    const allowed =
        selected == null
            ? null
            : new Set(selected.map((ref) => ref.toLowerCase()))
    return detail.queue.filter(
        (task) =>
            !omitted.has(task.ref.toLowerCase()) &&
            (allowed === null || allowed.has(task.ref.toLowerCase())),
    )
}

function nextIncludedTask(
    detail: WorkPackageDetail,
    excluded: readonly string[],
    selected?: readonly string[] | null,
) {
    const eligible = {
        ...detail,
        queue: includedTasks(detail, excluded, selected),
    }
    return nextWorkableTask(eligible)
}

/**
 * Why the work package cannot be worked unattended right now, or null when it can.
 *
 * Shared by the start path and by each hop of the loop, so a condition that
 * refuses to start also stops a run that hits it halfway through. `allowRef` is
 * the task the caller is about to work: a task already in progress blocks a new
 * agent unless it is that one, which is `/work-task` carrying on rather than
 * starting a second.
 */
function whyNotWorkable(
    detail: WorkPackageDetail,
    allowRef: string | null,
    excluded: readonly string[] = [],
    selected?: readonly string[] | null,
): string | null {
    const included = includedTasks(detail, excluded, selected)
    if (!included.length)
        return "There are no included tasks left in this work package for an agent to work."

    const next = nextIncludedTask(detail, excluded, selected)
    if (!next) {
        return "Every included task is waiting on unfinished work this run will not do."
    }

    const foreign = detail.inProgress.find(
        (task) => task.ref !== next.ref && task.ref !== allowRef,
    )
    if (foreign) {
        return (
            `${foreign.ref} (${foreign.title}) is already in progress. A task owns a branch and a ` +
            "checkpoint, and two at once corrupts both — finish or park it first."
        )
    }

    return null
}

export function startWorkPackageRun(input: StartWorkPackageRunInput): {
    workPackageRun: WorkPackageRun
    run: AgentRun
} {
    const workPackage = requireWorkPackage(input.workPackageRef)

    const previous = latestWorkPackageRun(workPackage.ref)
    if (workPackageRunActive(previous)) {
        throw new Error(
            `${workPackage.ref} already has a run in flight (work package run ${previous!.id}). Stop that one first.`,
        )
    }

    // One loop at a time across the whole workspace, not just per work package. Two loops
    // would be two agents on two branches with one working tree between them.
    const elsewhere = runningWorkPackageRuns()
    if (elsewhere.length) {
        const other = elsewhere[0]!
        throw new Error(
            `${other.workPackageRef} is already being worked by work package run ${other.id}. Stop it first.`,
        )
    }

    // `plan` can never finish a task by design — it reads and proposes and
    // changes nothing — so a loop in it would stall on its first task forever.
    if (input.permissionMode === "plan") {
        throw new Error(
            "A work package run cannot use Plan only: it changes nothing, so no task would ever complete.",
        )
    }

    const supervisor = input.supervisor
        ? unattendedSupervisor(input.supervisor, "clear a blocker")
        : null

    const detail = getWorkPackageDetail(workPackage.ref)
    const queued = new Map(
        detail.queue.map((task) => [task.ref.toLowerCase(), task.ref]),
    )
    const excluded = [
        ...new Set(input.excluded.map((ref) => ref.toLowerCase())),
    ].map((ref) => {
        const canonical = queued.get(ref)
        if (!canonical)
            throw new Error(
                `${ref} is not an unfinished task in ${workPackage.ref}.`,
            )
        return canonical
    })
    const selected =
        input.selected === undefined
            ? undefined
            : [...new Set(input.selected.map((ref) => ref.toLowerCase()))].map(
                  (ref) => {
                      const canonical = queued.get(ref)
                      if (!canonical)
                          throw new Error(
                              `${ref} is not an unfinished task in ${workPackage.ref}.`,
                          )
                      return canonical
                  },
              )
    const problem = whyNotWorkable(detail, null, excluded, selected)
    if (problem) throw new Error(problem)

    const next = nextIncludedTask(detail, excluded, selected)!
    const workPackageRun = createWorkPackageRun({
        workPackageRef: workPackage.ref,
        harness: input.harness as WorkPackageRun["harness"],
        model: input.model,
        permissionMode: input.permissionMode,
        extra: input.extra,
        excluded,
        selected,
        supervisor,
        fallback: input.fallback,
    })

    let run: AgentRun
    try {
        run = launch(workPackageRun, next.ref)
    } catch (caught) {
        // The row exists, so the failure is visible rather than being a start that
        // silently did not happen.
        settleWorkPackageRun(
            workPackageRun.id,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
        throw caught
    }

    return { workPackageRun: requireWorkPackageRun(workPackageRun.id), run }
}

/**
 * Attach a supervisor to a loop already under way, or change or remove the one
 * it has. An agent already at work is left alone; the change applies from the
 * next time a task stops short.
 */
export function setSupervisor(
    id: number,
    supervisor: RunSupervisor | null,
): WorkPackageRun {
    return setWorkPackageRunSupervisor(
        id,
        supervisor ? unattendedSupervisor(supervisor, "clear a blocker") : null,
    )
}

/** Point a fresh headless `/work-task` at one ref and record it as in flight. */
function launch(
    workPackageRun: WorkPackageRun,
    ref: string,
    handoff?: string,
): AgentRun {
    const task = findTask(ref)
    if (!task) throw new Error(`No task with ref '${ref}'.`)
    const model =
        workPackageRun.model === RECOMMENDED_MODEL
            ? ((task.recommendedTier
                  ? workspace().config.modelTiers[workPackageRun.harness]?.[
                        task.recommendedTier
                    ]
                  : "") ?? "")
            : workPackageRun.model
    const run = startRun({
        harness: workPackageRun.harness,
        model,
        mode: "print",
        command: "work-task",
        target: ref,
        extra: workPackageRun.extra,
        subjectKind: "task",
        subjectRef: ref,
        permissionMode: workPackageRun.permissionMode,
        handoff,
    })

    setWorkPackageRunCurrent(workPackageRun.id, run.id, ref)
    return run
}

/* -------------------------------------------------------------- resuming */

/** How much of a stopped agent's output is put in front of the next one. The
 *  rest stays in its log, which the next agent is pointed at. */
const HANDOFF_TAIL_CHARS = 12_000

/**
 * Set a stopped, blocked or failed loop going again from where it got to.
 *
 * The same row is reopened rather than a new one started, so the tab keeps one
 * history: what was worked stays worked, and the task that was in flight gets
 * its second agent listed under its first. That second agent starts fresh like
 * any other, but is handed the task and whatever the first one left behind, so
 * it carries the work on instead of starting it again.
 *
 * `knownRunIds` stands in for the recorded launches of a loop from before they
 * were recorded, so resuming it does not lose them.
 */
export function resumeWorkPackageRun(
    id: number,
    knownRunIds: number[],
    settings?: Parameters<typeof reopenWorkPackageRun>[2],
): { workPackageRun: WorkPackageRun; run: AgentRun } {
    const previous = requireWorkPackageRun(id)
    if (previous.status === "running")
        throw new Error(`Work package run ${id} is already running.`)
    const last =
        previous.currentRunId !== null
            ? findAgentRun(previous.currentRunId)
            : null
    if (last?.status === "running")
        throw new Error(
            `${previous.currentRef}'s agent is still running. Stop it before resuming.`,
        )

    const elsewhere = runningWorkPackageRuns()
    if (elsewhere.length) {
        const other = elsewhere[0]!
        throw new Error(
            `${other.workPackageRef} is already being worked by work package run ${other.id}. Stop it first.`,
        )
    }

    // The task in flight when it stopped comes first if it was left in
    // progress: that is the one `/work-task` refuses to work around.
    const detail = getWorkPackageDetail(previous.workPackageRef)
    const stranded = previous.currentRef
        ? detail.inProgress.find(
              (task) =>
                  task.ref.toLowerCase() === previous.currentRef!.toLowerCase(),
          )
        : undefined
    const problem = whyNotWorkable(
        detail,
        stranded?.ref ?? null,
        previous.excluded,
        previous.selected,
    )
    if (problem) throw new Error(problem)
    const next =
        stranded ??
        nextIncludedTask(detail, previous.excluded, previous.selected)!

    const reopened = reopenWorkPackageRun(id, knownRunIds, settings)
    try {
        const run = launch(reopened, next.ref, handoffFor(reopened, next))
        return { workPackageRun: requireWorkPackageRun(id), run }
    } catch (caught) {
        settleWorkPackageRun(
            id,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
        throw caught
    }
}

/** The agents this loop has launched at `ref`, oldest first. */
function agentsOn(workPackageRun: WorkPackageRun, ref: string): AgentRun[] {
    return workPackageRun.runIds
        .map((runId) => findAgentRun(runId))
        .filter(
            (agent): agent is AgentRun =>
                agent?.subjectRef.toLowerCase() === ref.toLowerCase(),
        )
}

const isSupervisor = (agent: AgentRun) => agent.command === "supervise-task"

function describeEnd(agent: AgentRun): string {
    return agent.status === "stopped"
        ? "was stopped before it finished"
        : agent.status === "failed"
          ? `exited with an error${agent.exitCode !== null ? ` (code ${agent.exitCode})` : ""}`
          : "exited without the task reaching Dev Complete with its work merged"
}

function taskSection(task: Task): string[] {
    const lines = [
        "### The task",
        "",
        `- Ref: ${task.ref}`,
        `- Title: ${task.title}`,
        `- Status: ${task.status}`,
        `- Branch: ${task.branchName ?? "(none assigned)"}`,
    ]
    if (task.targetBranches.length)
        lines.push(`- Merges into: ${task.targetBranches.join(", ")}`)
    if (task.description.trim())
        lines.push("", "Description:", "", task.description.trim())
    return lines
}

/** Where an agent's output is, and the end of it. */
function trailSection(agent: AgentRun, heading: string): string[] {
    const trail = runTrail(agent.id, HANDOFF_TAIL_CHARS)
    const lines = [heading, ""]
    if (trail.logPath) lines.push(`- Its full output log: \`${trail.logPath}\``)
    if (trail.transcriptPath)
        lines.push(
            `- Its conversation transcript (JSON lines): \`${trail.transcriptPath}\``,
        )
    lines.push("")
    if (trail.tail) {
        lines.push("The end of its output:", "", "````text", trail.tail, "````")
    } else {
        lines.push(
            "It wrote no output before it ended, so its transcript (if listed above) and the",
            "state of the repository are all there is to go on.",
        )
    }
    return lines
}

/**
 * What the agent picking a task back up needs to know: the task, why the loop
 * stopped, what the last agent on it got through, and what a supervisor did
 * about it since. Undefined when no agent in this run has touched the task,
 * since there is nothing to hand over.
 */
function handoffFor(
    workPackageRun: WorkPackageRun,
    task: Task,
): string | undefined {
    const agents = agentsOn(workPackageRun, task.ref)
    const worker = agents.findLast((agent) => !isSupervisor(agent))
    if (!worker) return undefined
    const supervisor = agents.findLast(
        (agent) => isSupervisor(agent) && agent.id > worker.id,
    )

    const lines = [
        "## Picking up a task another agent started",
        "",
        `An earlier agent was working ${task.ref} as part of this unattended run and ${describeEnd(worker)}.`,
    ]
    if (workPackageRun.stopReason)
        lines.push(
            `The run recorded why it stopped: ${workPackageRun.stopReason}`,
        )
    if (supervisor)
        lines.push(
            "A supervisor has since dealt with what stopped it. Its report is below, and the",
            "decisions it made stand: follow them rather than asking again.",
        )
    lines.push(
        "",
        "Do not start the task over. Work out how far it got first — the task's status, its",
        "branch and `git status`/`git log` there, any checkpoints already captured — and carry",
        "on from that point. Anything it left half-done is yours to finish or undo.",
        "",
        ...taskSection(task),
        "",
        ...trailSection(worker, "### What the earlier agent left behind"),
    )
    if (supervisor) {
        lines.push(
            "",
            "### The supervisor's report",
            "",
            runResult(supervisor.id) ?? "(It wrote no report.)",
        )
    }
    return lines.join("\n")
}

/** Opens the line of a supervisor's brief that says why it was called in. */
const CALLED_FOR = "The run could not carry on because: "

/** Why a task's supervisor was called in, read back from the brief it was
 *  launched with. */
export function supervisorCalledFor(prompt: string): string | null {
    const line = prompt.split("\n").find((one) => one.startsWith(CALLED_FOR))
    return line ? line.slice(CALLED_FOR.length).trim() || null : null
}

/**
 * The brief a supervisor is launched with: what went wrong on the task and
 * everything the agent working it left behind, plus what any earlier
 * supervisor on the same task tried.
 */
function supervisorBrief(
    workPackageRun: WorkPackageRun,
    task: Task,
    worker: AgentRun,
    shortfall: string,
): string {
    const lines = [
        "## The brief",
        "",
        `The agent working ${task.ref} ${describeEnd(worker)}.`,
        `${CALLED_FOR}${shortfall}`,
        "",
        ...taskSection(task),
        "",
        ...trailSection(worker, "### What the task's agent left behind"),
    ]
    const earlier = agentsOn(workPackageRun, task.ref).filter(isSupervisor)
    for (const [index, supervisor] of earlier.entries()) {
        lines.push(
            "",
            `### Supervisor ${index + 1}'s report on this task`,
            "",
            "The task stopped again after this, so whatever it did was not enough.",
            "",
            runResult(supervisor.id) ?? "(It wrote no report.)",
        )
    }
    return lines.join("\n")
}

/** Call the run's supervisor in on a task that stopped short. */
function launchSupervisor(
    workPackageRun: WorkPackageRun,
    supervisor: RunSupervisor,
    task: Task,
    worker: AgentRun,
    shortfall: string,
): AgentRun {
    const run = startRun({
        harness: supervisor.harness,
        model: supervisor.model,
        mode: "print",
        command: "supervise-task",
        target: task.ref,
        extra: supervisor.extra,
        subjectKind: "task",
        subjectRef: task.ref,
        permissionMode: supervisor.permissionMode,
        handoff: supervisorBrief(workPackageRun, task, worker, shortfall),
    })
    setWorkPackageRunCurrent(workPackageRun.id, run.id, task.ref)
    return run
}

/**
 * Why a task the loop just worked is not done, or null when it is. Dev
 * Complete is necessary but not sufficient: `tasks done` moves the status
 * whatever became of the merge — a pushed branch is refused, a collision
 * aborts — and it exits 0 either way, so a task can sit at Dev Complete with
 * its work still only on its own branch. Waving that through would branch the
 * next task from a tip that is missing it.
 */
function whyNotDone(task: Task): string | null {
    if (task.status === "backlog" || task.status === "in_progress") {
        return (
            `${task.ref} (${task.title}) finished without reaching Dev Complete, so its agent stopped for ` +
            "something it wants a person for. Read its log, or resume its session, before carrying on."
        )
    }
    return whyNotOnTargetBranches(task)
}

/* ---------------------------------------------------------------- the loop */

/**
 * One hop: the agent working `agentRunId` has exited, so decide what happens
 * next.
 *
 * Called for every run that settles, including runs no loop started — those
 * find no work package run and return, which is why this can be a blanket listener.
 *
 * ## The supervisor
 *
 * When a task's agent stops short and the run has a supervisor, the loop calls
 * it in instead of stopping. It stands in for the user, clears the blocker, and
 * ends on a verdict. If the task is done by then, the loop simply carries on. If
 * the supervisor says it cleared the way, a fresh agent picks the task back up
 * with its report. Otherwise the run stops for a person, as it would have
 * without one. A task gets `MAX_SUPERVISIONS_PER_TASK` of these at most, so a
 * blocker nobody can clear stops the run instead of cycling.
 */
function advance(agentRunId: number, status: AgentRunStatus): void {
    const workPackageRun = workPackageRunForAgentRun(agentRunId)
    if (!workPackageRun) return

    const ref = workPackageRun.currentRef
    if (!ref) {
        settleWorkPackageRun(
            workPackageRun.id,
            "failed",
            "The run in flight had no task recorded against it.",
        )
        return
    }

    const agent = findAgentRun(agentRunId)
    const supervising = !!agent && isSupervisor(agent)
    const whose = supervising ? `The supervisor on ${ref}` : `${ref}'s agent`

    const limit = runUsageLimit(agentRunId)
    if (limit && status !== "stopped") {
        settleWorkPackageRun(
            workPackageRun.id,
            "blocked",
            `${whose} reached Claude's ${limit.type.replaceAll("_", " ")} usage limit. Reset: ${new Date(limit.resetsAt * 1000).toLocaleString()}. Resume the run after the limit resets.`,
        )
        if (
            workPackageRun.fallback === "codex" &&
            agent?.harness === "claude"
        ) {
            try {
                const supervisor = workPackageRun.supervisor
                resumeWorkPackageRun(workPackageRun.id, workPackageRun.runIds, {
                    harness: "codex",
                    model: RECOMMENDED_MODEL,
                    permissionMode: workPackageRun.permissionMode,
                    extra: workPackageRun.extra,
                    supervisor:
                        supervisor?.harness === "claude"
                            ? { ...supervisor, harness: "codex", model: "" }
                            : supervisor,
                })
            } catch (caught) {
                settleWorkPackageRun(
                    workPackageRun.id,
                    "blocked",
                    `Claude reached its usage limit and the Codex fallback could not start: ${caught instanceof Error ? caught.message : String(caught)}`,
                )
            }
        }
        return
    }

    if (status === "stopped") {
        settleWorkPackageRun(
            workPackageRun.id,
            "stopped",
            `${whose} was stopped, so the loop stopped with it.`,
        )
        return
    }
    if (supervising && status !== "succeeded") {
        settleWorkPackageRun(
            workPackageRun.id,
            "failed",
            `${whose} exited with an error. Its log has the detail.`,
        )
        return
    }

    // Exiting cleanly is not the same as finishing the task — see the note at the
    // top of this file. The database is what decides.
    const task = findTask(ref)
    if (!task) {
        settleWorkPackageRun(
            workPackageRun.id,
            "blocked",
            `${ref} no longer exists, so the loop cannot tell what happened to it.`,
        )
        return
    }
    const failed = status !== "succeeded"
    const shortfall = failed
        ? `${ref}'s agent exited with an error. Its log has the detail.`
        : whyNotDone(task)

    if (shortfall && supervising) {
        // No verdict counts as unresolved: a supervisor that cannot say it
        // cleared the blocker has not.
        if (supervisorVerdict(agentRunId) !== "resolved") {
            settleWorkPackageRun(
                workPackageRun.id,
                "blocked",
                `${shortfall} The supervisor looked at it and could not clear it, so it needs a ` +
                    `person — its report is under ${ref}.`,
            )
            return
        }
        try {
            launch(workPackageRun, ref, handoffFor(workPackageRun, task))
        } catch (caught) {
            settleWorkPackageRun(
                workPackageRun.id,
                "failed",
                caught instanceof Error ? caught.message : String(caught),
            )
        }
        return
    }

    if (shortfall) {
        const supervisor = workPackageRun.supervisor
        const since = workPackageRun.resumedAt ?? ""
        const called = agentsOn(workPackageRun, ref).filter(
            (one) => isSupervisor(one) && one.createdAt >= since,
        ).length
        if (!supervisor || !agent) {
            settleWorkPackageRun(
                workPackageRun.id,
                failed ? "failed" : "blocked",
                shortfall,
            )
            return
        }
        if (called >= MAX_SUPERVISIONS_PER_TASK) {
            settleWorkPackageRun(
                workPackageRun.id,
                "blocked",
                `${shortfall} The supervisor has already been called in ${called} times on ${ref}, ` +
                    "so it is left for a person.",
            )
            return
        }
        try {
            launchSupervisor(workPackageRun, supervisor, task, agent, shortfall)
        } catch (caught) {
            settleWorkPackageRun(
                workPackageRun.id,
                "failed",
                caught instanceof Error ? caught.message : String(caught),
            )
        }
        return
    }

    recordWorkPackageRunWorked(workPackageRun.id, ref)
    const current = requireWorkPackageRun(workPackageRun.id)

    const detail = getWorkPackageDetail(current.workPackageRef)
    if (!includedTasks(detail, current.excluded, current.selected).length) {
        settleWorkPackageRun(current.id, "finished", "")
        return
    }

    const problem = whyNotWorkable(
        detail,
        null,
        current.excluded,
        current.selected,
    )
    if (problem) {
        settleWorkPackageRun(current.id, "blocked", problem)
        return
    }

    const next = nextIncludedTask(detail, current.excluded, current.selected)!
    if (current.worked.includes(next.ref)) {
        settleWorkPackageRun(
            current.id,
            "blocked",
            `${next.ref} came back to the front of the queue after this run had already finished it. ` +
                "Something is moving tasks backwards, and going round again would not help.",
        )
        return
    }
    if (current.worked.length >= MAX_TASKS_PER_RUN) {
        settleWorkPackageRun(
            current.id,
            "blocked",
            `Stopped after ${MAX_TASKS_PER_RUN} tasks, which is as far as one run goes.`,
        )
        return
    }

    try {
        launch(current, next.ref)
    } catch (caught) {
        settleWorkPackageRun(
            current.id,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
    }
}

onRunSettled(advance)

/**
 * Why a Dev Complete task's work is not on all of its target branches, or null
 * when it is. See `missingTargets` for how each is judged.
 */
function whyNotOnTargetBranches(task: Task): string | null {
    if (!task.useGitWorkflow) return null
    const missing = missingTargets(task)
    if (!missing.length) return null

    if (!task.branchName) {
        return `${task.ref} (${task.title}) reached Dev Complete with no branch assigned, so there is nothing to merge into ${missing.map((one) => `'${one.branchName}'`).join(", ")}.`
    }
    return (
        `${task.ref} (${task.title}) reached Dev Complete but is not on ` +
        `${missing.map((one) => `'${one.branchName}'`).join(", ")}, so the merge did not happen — its branch may have been pushed, or its ` +
        "commits may collide with work already there. Carrying on would branch the next task from a " +
        "tip that is missing this one."
    )
}

/* ------------------------------------------------------------- stop, reset */

export function stopWorkPackageRun(id: number): WorkPackageRun {
    const workPackageRun = requireWorkPackageRun(id)
    if (workPackageRun.status !== "running")
        throw new Error(`Work package run ${id} is not running.`)

    // Settled first, so the agent's own exit finds a loop that has already
    // stopped rather than one asking it what to do next.
    const settled = settleWorkPackageRun(id, "stopped", "Stopped by hand.")

    if (workPackageRun.currentRunId !== null) {
        try {
            stopRun(workPackageRun.currentRunId)
        } catch {
            // Already finished on its own between the two lines. Nothing to kill.
        }
    }

    return settled
}

/**
 * A `running` loop whose agents died with the server is a lie the next page load
 * would repeat forever.
 *
 * Not resumed, only settled. Resuming is one click on the run's tab; quietly
 * launching agents at boot because a row said `running` is not something a
 * restart should do on its own.
 */
export function reconcileWorkPackageRuns(): void {
    for (const workPackageRun of runningWorkPackageRuns()) {
        settleWorkPackageRun(
            workPackageRun.id,
            "stopped",
            "The server restarted, which ended the agent it was running.",
        )
    }
}
