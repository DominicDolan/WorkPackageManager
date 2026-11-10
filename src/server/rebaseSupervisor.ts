import {
    conflictBrief,
    findAgentRun,
    onRunSettled,
    runResult,
    startRun,
    stopRun,
} from "./agents"
import {
    currentBranch,
    isAncestor,
    rebaseInProgress,
    switchBranch,
    workingTreeClean,
} from "./branches"
import { announceChange } from "./watch"
import { workspace } from "../config/paths"
import type {
    AgentRunStatus,
    GitConflict,
    RebaseSupervision,
    RebaseSupervisionStatus,
    RunSupervisor,
} from "../shared/types"

/**
 * A rebase onto the base branch with a supervisor standing by.
 *
 * The rebase itself is the ordinary one, which aborts when it stops on
 * conflicts. With a supervisor, that conflict report goes straight to a
 * headless `resolve-conflicts` agent instead of to a dialog asking whether to
 * hand it to one, so the rebase can be left to finish on its own.
 *
 * Whether it worked is answered by Git, not by the agent: the branch is rebased
 * when no rebase is left in progress and the base is an ancestor of the
 * branch. An agent that gives up is told to abort, which leaves the branch as
 * it was. One that is stopped part-way has its rebase aborted here, for the
 * same reason.
 *
 * State is in memory, like a supervised checks run: the agent is a child of
 * this server and does not outlive it.
 */

interface Supervision {
    branch: string
    onto: string
    supervisor: RunSupervisor
    status: RebaseSupervisionStatus
    startedAt: string
    stopReason: string
    conflict: GitConflict
    pushed: boolean
    agentRunId: number | null
    /** Where the working tree was before the rebase, to go back to after. */
    from: string | null
}

const supervisions = new Map<string, Supervision>()

/** Told to the agent on top of the `resolve-conflicts` instructions, which
 *  assume someone is there to ask. */
const UNATTENDED = `## Nobody is watching this run

This rebase was started with a supervisor, which is you: nobody is here to
answer a question. Where a conflict is a genuine disagreement, decide which
intent should win from the code, notes and commit messages, and say what you
decided in your report. If you cannot settle it safely, run \`git rebase --abort\`
so the branch is left as it was, and explain the blocker.`

export function rebaseSupervision(branch: string): RebaseSupervision | null {
    const supervision = supervisions.get(branch)
    if (!supervision) return null
    const agent =
        supervision.agentRunId !== null
            ? findAgentRun(supervision.agentRunId)
            : null
    return {
        branch: supervision.branch,
        onto: supervision.onto,
        supervisor: supervision.supervisor,
        status: supervision.status,
        startedAt: supervision.startedAt,
        stopReason: supervision.stopReason,
        conflict: supervision.conflict,
        pushed: supervision.pushed,
        agent: agent && {
            id: agent.id,
            command: agent.command,
            status: agent.status,
            exitCode: agent.exitCode,
            createdAt: agent.createdAt,
            finishedAt: agent.finishedAt,
            sessionId: agent.sessionId,
        },
    }
}

export function rebaseSupervised(branch: string): boolean {
    return supervisions.get(branch)?.status === "resolving"
}

/** Forget a settled supervision, so its outcome stops describing a branch
 *  that has since been rebased again. */
export function clearRebaseSupervision(branch: string): void {
    if (!rebaseSupervised(branch)) supervisions.delete(branch)
}

/**
 * Hand a rebase that stopped on conflicts to the supervisor, whose settings
 * have already been made unattended. `from` is the branch the working tree was
 * on before the rebase, which it is put back on once the supervisor finishes.
 */
export function superviseRebaseConflict(input: {
    conflict: GitConflict
    supervisor: RunSupervisor
    pushed: boolean
    from: string | null
}): RebaseSupervision {
    const { conflict, supervisor } = input
    if (rebaseSupervised(conflict.branch))
        throw new Error(
            `A supervisor is already resolving the rebase of '${conflict.branch}'.`,
        )
    const supervision: Supervision = {
        branch: conflict.branch,
        onto: conflict.onto,
        supervisor,
        status: "resolving",
        startedAt: new Date().toISOString(),
        stopReason: "",
        conflict,
        pushed: input.pushed,
        agentRunId: null,
        from: input.from,
    }
    supervisions.set(conflict.branch, supervision)
    try {
        const run = startRun({
            harness: supervisor.harness,
            model: supervisor.model,
            mode: "print",
            command: "resolve-conflicts",
            target: conflict.branch,
            extra: conflictBrief(conflict, supervisor.extra),
            subjectKind: "branch",
            subjectRef: conflict.branch,
            permissionMode: supervisor.permissionMode,
            handoff: UNATTENDED,
        })
        supervision.agentRunId = run.id
    } catch (caught) {
        settle(
            supervision,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
    }
    return rebaseSupervision(conflict.branch)!
}

export function stopRebaseSupervisor(branch: string): void {
    const supervision = supervisions.get(branch)
    if (!supervision || supervision.status !== "resolving")
        throw new Error(`No supervisor is resolving the rebase of '${branch}'.`)
    if (supervision.agentRunId === null) return
    // The agent's exit settles the supervision and aborts its rebase.
    stopRun(supervision.agentRunId)
}

function settle(
    supervision: Supervision,
    status: RebaseSupervisionStatus,
    reason: string,
): void {
    supervision.status = status
    supervision.stopReason = reason
    announceChange("tasks")
}

function abortRebase(): boolean {
    const result = Bun.spawnSync(["git", "rebase", "--abort"], {
        cwd: workspace().repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    return result.exitCode === 0
}

/** Put the working tree back where it was before the rebase, when that is
 *  safe: the agent left it on the rebased branch and clean. */
function restoreBranch(supervision: Supervision): void {
    const { from, branch } = supervision
    if (!from || from === branch || currentBranch() !== branch) return
    if (!workingTreeClean()) return
    try {
        switchBranch(from)
    } catch {
        // Staying on the rebased branch is harmless; it is only not where the
        // user was.
    }
}

/** The supervisor has exited: judge the rebase by what Git says. */
function supervisorSettled(agentRunId: number, status: AgentRunStatus): void {
    const supervision = [...supervisions.values()].find(
        (one) => one.agentRunId === agentRunId,
    )
    if (!supervision || supervision.status !== "resolving") return
    const { branch, onto } = supervision

    if (rebaseInProgress()) {
        if (status === "stopped") {
            const aborted = abortRebase()
            settle(
                supervision,
                "stopped",
                aborted
                    ? `The supervisor was stopped, so its rebase was aborted and '${branch}' is as it was.`
                    : "The supervisor was stopped, and its rebase could not be aborted. Finish it or run 'git rebase --abort'.",
            )
            if (aborted) restoreBranch(supervision)
            return
        }
        settle(
            supervision,
            "blocked",
            "The supervisor finished with the rebase still in progress. Finish it " +
                "('git rebase --continue') or cancel it ('git rebase --abort').",
        )
        return
    }

    if (isAncestor(onto, branch)) {
        restoreBranch(supervision)
        settle(supervision, "rebased", "")
        return
    }

    restoreBranch(supervision)
    const report = runResult(agentRunId)
    settle(
        supervision,
        status === "stopped"
            ? "stopped"
            : status === "failed"
              ? "failed"
              : "blocked",
        status === "stopped"
            ? `The supervisor was stopped before '${branch}' was rebased.`
            : status === "failed"
              ? `The supervisor exited with an error before '${branch}' was rebased. Its output has the detail.`
              : `The supervisor could not rebase '${branch}' onto '${onto}', so it needs a person.` +
                (report ? " Its report is below." : ""),
    )
}

onRunSettled(supervisorSettled)
