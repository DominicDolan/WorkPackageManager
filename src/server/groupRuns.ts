import { onRunSettled, startRun, stopRun } from "./agents"
import { branchExists, isAncestor } from "./branches"
import { getGroupDetail, groupBranchOf } from "./groupBranch"
import {
  createGroupRun,
  findTask,
  groupRunForAgentRun,
  latestGroupRun,
  recordGroupRunWorked,
  requireGroup,
  requireGroupRun,
  runningGroupRuns,
  setGroupRunCurrent,
  settleGroupRun,
} from "./repo"
import {
  groupRunActive,
  nextWorkableTask,
  type AgentPermissionMode,
  type AgentRun,
  type AgentRunStatus,
  type GroupRun,
  type TaskGroupDetail,
} from "../shared/types"

/**
 * Working a whole group unattended, one fresh agent per task.
 *
 * The problem this solves is context, not clicking. `/work-group` already
 * walks a group's queue, but it does it inside a single conversation, so by the
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
 * moved nothing stops the loop rather than rolling the group forward past a
 * task nobody finished.
 *
 * ## Stopping
 *
 * Everything here fails towards stopping. A task that did not complete, a queue
 * that stopped shrinking, a task in flight that this loop did not start, a
 * server restart — each settles the run and leaves what was already merged
 * exactly where it is. A partly delivered group is the normal recoverable
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

export interface StartGroupRunInput {
  groupRef: string
  harness: string
  model: string
  permissionMode: AgentPermissionMode
  /** Extra prompt text appended to every task in the loop, not just the first. */
  extra: string
  /** Unfinished tasks the user chose to leave out of this run. */
  excluded: string[]
}

function nextIncludedTask(
  detail: TaskGroupDetail,
  excluded: readonly string[],
) {
  const omitted = new Set(excluded.map((ref) => ref.toLowerCase()))
  const eligible = {
    ...detail,
    queue: detail.queue.filter((task) => !omitted.has(task.ref.toLowerCase())),
  }
  return nextWorkableTask(eligible)
}

/**
 * Why the group cannot be worked unattended right now, or null when it can.
 *
 * Shared by the start path and by each hop of the loop, so a condition that
 * refuses to start also stops a run that hits it halfway through. `allowRef` is
 * the task the caller is about to work: a task already in progress blocks a new
 * agent unless it is that one, which is `/work-task` carrying on rather than
 * starting a second.
 */
function whyNotWorkable(
  detail: TaskGroupDetail,
  allowRef: string | null,
  excluded: readonly string[] = [],
): string | null {
  const omitted = new Set(excluded.map((ref) => ref.toLowerCase()))
  const included = detail.queue.filter(
    (task) => !omitted.has(task.ref.toLowerCase()),
  )
  if (!included.length)
    return "There are no included tasks left in this group for an agent to work."

  const next = nextIncludedTask(detail, excluded)
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

export function startGroupRun(input: StartGroupRunInput): {
  groupRun: GroupRun
  run: AgentRun
} {
  const group = requireGroup(input.groupRef)

  const previous = latestGroupRun(group.ref)
  if (groupRunActive(previous)) {
    throw new Error(
      `${group.ref} already has a run in flight (group run ${previous!.id}). Stop that one first.`,
    )
  }

  // One loop at a time across the whole workspace, not just per group. Two loops
  // would be two agents on two branches with one working tree between them.
  const elsewhere = runningGroupRuns()
  if (elsewhere.length) {
    const other = elsewhere[0]!
    throw new Error(
      `${other.groupRef} is already being worked by group run ${other.id}. Stop it first.`,
    )
  }

  // `plan` can never finish a task by design — it reads and proposes and
  // changes nothing — so a loop in it would stall on its first task forever.
  if (input.permissionMode === "plan") {
    throw new Error(
      "A group run cannot use Plan only: it changes nothing, so no task would ever complete.",
    )
  }

  const detail = getGroupDetail(group.ref)
  const queued = new Map(
    detail.queue.map((task) => [task.ref.toLowerCase(), task.ref]),
  )
  const excluded = [
    ...new Set(input.excluded.map((ref) => ref.toLowerCase())),
  ].map((ref) => {
    const canonical = queued.get(ref)
    if (!canonical)
      throw new Error(`${ref} is not an unfinished task in ${group.ref}.`)
    return canonical
  })
  const problem = whyNotWorkable(detail, null, excluded)
  if (problem) throw new Error(problem)

  const next = nextIncludedTask(detail, excluded)!
  const groupRun = createGroupRun({
    groupRef: group.ref,
    harness: input.harness as GroupRun["harness"],
    model: input.model,
    permissionMode: input.permissionMode,
    extra: input.extra,
    excluded,
  })

  let run: AgentRun
  try {
    run = launch(groupRun, next.ref)
  } catch (caught) {
    // The row exists, so the failure is visible rather than being a start that
    // silently did not happen.
    settleGroupRun(
      groupRun.id,
      "failed",
      caught instanceof Error ? caught.message : String(caught),
    )
    throw caught
  }

  return { groupRun: requireGroupRun(groupRun.id), run }
}

/** Point a fresh headless `/work-task` at one ref and record it as in flight. */
function launch(groupRun: GroupRun, ref: string): AgentRun {
  const run = startRun({
    harness: groupRun.harness,
    model: groupRun.model,
    mode: "print",
    command: "work-task",
    target: ref,
    extra: groupRun.extra,
    subjectKind: "task",
    subjectRef: ref,
    permissionMode: groupRun.permissionMode,
  })

  setGroupRunCurrent(groupRun.id, run.id, ref)
  return run
}

/* ---------------------------------------------------------------- the loop */

/**
 * One hop: the agent working `agentRunId` has exited, so decide what happens
 * next.
 *
 * Called for every run that settles, including runs no loop started — those
 * find no group run and return, which is why this can be a blanket listener.
 */
function advance(agentRunId: number, status: AgentRunStatus): void {
  const groupRun = groupRunForAgentRun(agentRunId)
  if (!groupRun) return

  const ref = groupRun.currentRef
  if (!ref) {
    settleGroupRun(
      groupRun.id,
      "failed",
      "The run in flight had no task recorded against it.",
    )
    return
  }

  if (status === "stopped") {
    settleGroupRun(
      groupRun.id,
      "stopped",
      `${ref}'s agent was stopped, so the loop stopped with it.`,
    )
    return
  }
  if (status !== "succeeded") {
    settleGroupRun(
      groupRun.id,
      "failed",
      `${ref}'s agent exited with an error. Its log has the detail.`,
    )
    return
  }

  // Exiting cleanly is not the same as finishing the task — see the note at the
  // top of this file. The database is what decides.
  const task = findTask(ref)
  if (!task) {
    settleGroupRun(
      groupRun.id,
      "blocked",
      `${ref} no longer exists, so the loop cannot tell what happened to it.`,
    )
    return
  }
  if (task.status === "backlog" || task.status === "in_progress") {
    settleGroupRun(
      groupRun.id,
      "blocked",
      `${ref} (${task.title}) finished without reaching Dev Complete, so its agent stopped for ` +
        "something it wants a person for. Read its log, or resume its session, before carrying on.",
    )
    return
  }

  // Dev Complete is necessary but not sufficient. `tasks done` moves the status
  // whatever became of the merge — a pushed branch is refused, a collision
  // aborts — and it exits 0 either way, so a task can sit at Dev Complete with
  // its work still only on its own branch. Waving that through would branch the
  // next task from a tip that is missing it.
  const unmerged = whyNotOnGroupBranch(task)
  if (unmerged) {
    settleGroupRun(groupRun.id, "blocked", unmerged)
    return
  }

  recordGroupRunWorked(groupRun.id, ref)
  const current = requireGroupRun(groupRun.id)

  const detail = getGroupDetail(current.groupRef)
  if (
    !detail.queue.some(
      (task) =>
        !current.excluded.some(
          (ref) => ref.toLowerCase() === task.ref.toLowerCase(),
        ),
    )
  ) {
    settleGroupRun(current.id, "finished", "")
    return
  }

  const problem = whyNotWorkable(detail, null, current.excluded)
  if (problem) {
    settleGroupRun(current.id, "blocked", problem)
    return
  }

  const next = nextIncludedTask(detail, current.excluded)!
  if (current.worked.includes(next.ref)) {
    settleGroupRun(
      current.id,
      "blocked",
      `${next.ref} came back to the front of the queue after this run had already finished it. ` +
        "Something is moving tasks backwards, and going round again would not help.",
    )
    return
  }
  if (current.worked.length >= MAX_TASKS_PER_RUN) {
    settleGroupRun(
      current.id,
      "blocked",
      `Stopped after ${MAX_TASKS_PER_RUN} tasks, which is as far as one run goes.`,
    )
    return
  }

  try {
    launch(current, next.ref)
  } catch (caught) {
    settleGroupRun(
      current.id,
      "failed",
      caught instanceof Error ? caught.message : String(caught),
    )
  }
}

onRunSettled(advance)

/**
 * Why a Dev Complete task's work is not on its group's branch, or null when it
 * is.
 *
 * Answered from Git rather than from the delivery record, because the record is
 * written by the merge that may not have happened. Ancestry is the whole test,
 * and it holds precisely because the merge is a rebase and fast-forward: the
 * task branch tip *becomes* the group branch tip, so a task that landed is
 * always an ancestor and one that did not never is.
 */
function whyNotOnGroupBranch(task: {
  ref: string
  title: string
  branchName: string | null
  groupRef: string | null
}): string | null {
  const resolved = groupBranchOf(task as Parameters<typeof groupBranchOf>[0])
  if (!resolved) return null

  if (!task.branchName) {
    return `${task.ref} (${task.title}) reached Dev Complete with no branch assigned, so there is nothing to merge into '${resolved.branch}'.`
  }
  if (
    !branchExists(resolved.branch) ||
    !isAncestor(task.branchName, resolved.branch)
  ) {
    return (
      `${task.ref} (${task.title}) reached Dev Complete but '${task.branchName}' is not on ` +
      `'${resolved.branch}', so the merge did not happen — its branch may have been pushed, or its ` +
      "commits may collide with work already there. Carrying on would branch the next task from a " +
      "tip that is missing this one."
    )
  }

  return null
}

/* ------------------------------------------------------------- stop, reset */

export function stopGroupRun(id: number): GroupRun {
  const groupRun = requireGroupRun(id)
  if (groupRun.status !== "running")
    throw new Error(`Group run ${id} is not running.`)

  // Settled first, so the agent's own exit finds a loop that has already
  // stopped rather than one asking it what to do next.
  const settled = settleGroupRun(id, "stopped", "Stopped by hand.")

  if (groupRun.currentRunId !== null) {
    try {
      stopRun(groupRun.currentRunId)
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
 * Not resumed, only settled. Restarting a group is one click and it re-derives
 * the queue from scratch; quietly launching agents at boot because a row said
 * `running` is not something a restart should do on its own.
 */
export function reconcileGroupRuns(): void {
  for (const groupRun of runningGroupRuns()) {
    settleGroupRun(
      groupRun.id,
      "stopped",
      "The server restarted, which ended the agent it was running.",
    )
  }
}
