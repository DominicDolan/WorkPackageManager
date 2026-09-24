import {
    findAgentRun,
    unattendedSupervisor,
    onRunSettled,
    runResult,
    startRun,
    stopRun,
    supervisorVerdict,
} from "./agents"
import { startChecks } from "./checks"
import { findCombinedBranch } from "./repo"
import { announceChange } from "./watch"
import { workspace } from "../config/paths"
import { checkPassed } from "../shared/checks"
import {
    MAX_SUPERVISIONS_PER_CHECK,
    checksSupervisionActive,
    type AgentRunStatus,
    type CheckRun,
    type ChecksReport,
    type ChecksSupervision,
    type ChecksSupervisionStatus,
    type RunSupervisor,
} from "../shared/types"

/**
 * Pre-PR checks with a supervisor standing by.
 *
 * The same idea as a work package run's supervisor, applied to the checks: the
 * suite stops at its first failure, and instead of waiting for a person the
 * failure goes to a fresh headless agent to fix. When that agent ends on
 * `RESOLVED` the suite resumes. Resume keeps passes only for the same commit,
 * so a supervisor that committed its fix, as it is told to, has the whole
 * suite run again against the new head, and one that changed nothing has only
 * the failing check and those after it run.
 *
 * Everything fails towards stopping. The supervisor saying it could not fix it,
 * saying nothing, being stopped, erroring, or failing the same check
 * `MAX_SUPERVISIONS_PER_CHECK` times each settles the run and leaves the
 * branch as it is for a person.
 *
 * State is in memory, like the checks' own progress. The agents it launches are
 * children of this server and die with it, so nothing survives a restart for a
 * stored row to describe.
 */

interface Supervision {
    branch: string
    base: string
    supervisor: RunSupervisor
    status: ChecksSupervisionStatus
    startedAt: string
    stopReason: string
    attempts: { check: string; calledFor: string; agentRunId: number }[]
    /** The supervisor at work right now, if any. */
    currentAgentId: number | null
}

const supervisions = new Map<string, Supervision>()

/** How much of a failing check's output goes in the brief. The captured output
 *  is already capped, and failures are read from the bottom. */
const BRIEF_OUTPUT_CHARS = 12_000

export function checksSupervision(branch: string): ChecksSupervision | null {
    const supervision = supervisions.get(branch)
    if (!supervision) return null
    return {
        branch: supervision.branch,
        supervisor: supervision.supervisor,
        status: supervision.status,
        startedAt: supervision.startedAt,
        stopReason: supervision.stopReason,
        agents: supervision.attempts.flatMap(
            ({ check, calledFor, agentRunId }) => {
                const agent = findAgentRun(agentRunId)
                return agent
                    ? [
                          {
                              check,
                              id: agent.id,
                              command: agent.command,
                              status: agent.status,
                              exitCode: agent.exitCode,
                              createdAt: agent.createdAt,
                              finishedAt: agent.finishedAt,
                              calledFor,
                              verdict:
                                  agent.status === "running"
                                      ? null
                                      : supervisorVerdict(agent.id),
                          },
                      ]
                    : []
            },
        ),
    }
}

/** Whether checks on this branch are under a supervisor right now, which is
 *  a reason to refuse a run started by hand on top of it. */
export function checksSupervised(branch: string): boolean {
    return checksSupervisionActive(checksSupervision(branch))
}

/** Forget a settled supervision, so its outcome stops describing a branch
 *  whose checks have since been run by hand. */
export function clearChecksSupervision(branch: string): void {
    if (!checksSupervised(branch)) supervisions.delete(branch)
}

export function startSupervisedChecks(input: {
    branch: string
    base: string
    resume: boolean
    previous: ChecksReport | null
    supervisor: RunSupervisor
}): void {
    if (checksSupervised(input.branch))
        throw new Error(
            `Checks on '${input.branch}' are already running with a supervisor.`,
        )
    const supervision: Supervision = {
        branch: input.branch,
        base: input.base,
        supervisor: unattendedSupervisor(input.supervisor, "fix a check"),
        status: "checking",
        startedAt: new Date().toISOString(),
        stopReason: "",
        attempts: [],
        currentAgentId: null,
    }
    // Throws when a run is already going, before anything is recorded.
    startChecks({
        branch: input.branch,
        base: input.base,
        resume: input.resume,
        previous: input.previous,
        onFinished: (report) => checked(supervision, report),
    })
    supervisions.set(input.branch, supervision)
}

export function stopSupervisedChecks(branch: string): void {
    const supervision = supervisions.get(branch)
    if (!supervision || !checksSupervisionActive(supervision))
        throw new Error(`Checks on '${branch}' are not being supervised.`)
    // Settled first, so the agent's own exit finds a run that has already
    // stopped rather than one asking it what to do next. A check already
    // running is left to finish; its report is kept, but nothing follows it.
    settle(supervision, "stopped", "Stopped by hand.")
    if (supervision.currentAgentId !== null) {
        try {
            stopRun(supervision.currentAgentId)
        } catch {
            // Already finished on its own. Nothing to kill.
        }
    }
}

type SettledListener = (branch: string) => void
const settledListeners = new Set<SettledListener>()

/** Told when a supervised checks run settles, however it did. Registered
 *  rather than imported, so a start-to-finish run can wait on the checks
 *  without this module depending on it. */
export function onChecksSupervisionSettled(listener: SettledListener): void {
    settledListeners.add(listener)
}

function settle(
    supervision: Supervision,
    status: ChecksSupervisionStatus,
    reason: string,
): void {
    supervision.status = status
    supervision.stopReason = reason
    announceChange("tasks")
    for (const listener of settledListeners) {
        try {
            listener(supervision.branch)
        } catch {
            // A listener that throws must not take the checks' bookkeeping with it.
        }
    }
}

/** The checks have finished a pass: carry on, call the supervisor, or stop. */
function checked(supervision: Supervision, report: ChecksReport | null): void {
    // Stopped by hand, or replaced by a newer supervision, while the checks ran.
    if (
        supervision.status !== "checking" ||
        supervisions.get(supervision.branch) !== supervision
    )
        return
    if (!report) {
        settle(
            supervision,
            "failed",
            "The checks could not be run. The server log has the detail.",
        )
        return
    }
    if (report.passed) {
        settle(supervision, "passed", "")
        return
    }

    const failure = report.checks.find((run) => !checkPassed(run))
    if (!failure) {
        settle(
            supervision,
            "blocked",
            "The checks stopped without finishing or reporting a failure.",
        )
        return
    }

    const earlier = supervision.attempts.filter(
        (attempt) => attempt.check === failure.name,
    )
    if (earlier.length >= MAX_SUPERVISIONS_PER_CHECK) {
        settle(
            supervision,
            "blocked",
            `${failure.name} still fails after the supervisor was called in ${earlier.length} times, ` +
                "so it is left for a person.",
        )
        return
    }

    try {
        const { supervisor } = supervision
        const run = startRun({
            harness: supervisor.harness,
            model: supervisor.model,
            mode: "print",
            command: "supervise-checks",
            target: supervision.branch,
            extra: supervisor.extra,
            subjectKind: "branch",
            subjectRef: supervision.branch,
            permissionMode: supervisor.permissionMode,
            handoff: brief(report, failure, earlier),
        })
        supervision.attempts.push({
            check: failure.name,
            calledFor: describeFailure(failure),
            agentRunId: run.id,
        })
        supervision.currentAgentId = run.id
        supervision.status = "fixing"
        announceChange("tasks")
    } catch (caught) {
        settle(
            supervision,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
    }
}

/** Why the supervisor was called in, in a line. */
function describeFailure(failure: CheckRun): string {
    if (failure.status === "timed_out")
        return `${failure.name} timed out after ${Math.round(failure.durationMs / 1000)}s.`
    if (failure.status === "error")
        return `${failure.name} could not run${failure.reason ? `: ${failure.reason}` : "."}`
    return `${failure.name} failed${failure.exitCode !== null ? ` with exit code ${failure.exitCode}` : ""}.`
}

/** What the supervisor is launched with: the failing check, its output, and
 *  what any earlier supervisor on the same check reported. */
function brief(
    report: ChecksReport,
    failure: CheckRun,
    earlier: Supervision["attempts"],
): string {
    const output =
        failure.output.length > BRIEF_OUTPUT_CHARS
            ? `… earlier output omitted …\n${failure.output.slice(-BRIEF_OUTPUT_CHARS)}`
            : failure.output
    const lines = [
        "## The brief",
        "",
        `- Branch: ${report.branch}`,
        `- Compared against: ${report.base}`,
        `- Commit checked: ${report.headSha ?? "(unknown)"}`,
        `- Working tree was on: ${report.ranOnBranch ?? "(detached)"}`,
        "",
        `### The failing check: ${failure.name}`,
        "",
        `- Command: \`${failure.command.join(" ")}\``,
        `- Working directory (from the repository root): \`${failure.cwd}\``,
        `- Result: ${failure.status}${failure.exitCode !== null ? ` (exit code ${failure.exitCode})` : ""}`,
    ]
    if (failure.reason) lines.push(`- Reason: ${failure.reason}`)
    lines.push(
        "",
        output.trim()
            ? ["Its output:", "", "````text", output, "````"].join("\n")
            : "It wrote no output.",
    )
    for (const [index, attempt] of earlier.entries()) {
        lines.push(
            "",
            `### Supervisor ${index + 1}'s report on this check`,
            "",
            "The check failed again after this, so whatever it did was not enough.",
            "",
            runResult(attempt.agentRunId) ?? "(It wrote no report.)",
        )
    }
    return lines.join("\n")
}

/** Whether tracked files have uncommitted changes. Untracked files are left
 *  out: build output and scratch files are not the supervisor's fix. */
function trackedChanges(): boolean {
    const result = Bun.spawnSync(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        {
            cwd: workspace().repoRoot,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        },
    )
    return result.exitCode === 0 && !!result.stdout.toString().trim()
}

/** A supervisor has exited: resume the checks, or stop for a person. */
function supervisorSettled(agentRunId: number, status: AgentRunStatus): void {
    const supervision = [...supervisions.values()].find(
        (one) => one.currentAgentId === agentRunId,
    )
    if (!supervision) return
    supervision.currentAgentId = null
    if (supervision.status !== "fixing") return

    const check =
        supervision.attempts.find((one) => one.agentRunId === agentRunId)
            ?.check ?? "the check"
    if (status === "stopped") {
        settle(
            supervision,
            "stopped",
            `The supervisor on ${check} was stopped, so the checks stopped with it.`,
        )
        return
    }
    if (status !== "succeeded") {
        settle(
            supervision,
            "failed",
            `The supervisor on ${check} exited with an error. Its output has the detail.`,
        )
        return
    }
    // No verdict counts as unresolved.
    if (supervisorVerdict(agentRunId) !== "resolved") {
        settle(
            supervision,
            "blocked",
            `The supervisor could not fix ${check}, so it needs a person. Its report is below.`,
        )
        return
    }
    // Checks read the working tree but are recorded against the commit, so a
    // fix left uncommitted would pass checks for code the branch does not have.
    if (trackedChanges()) {
        settle(
            supervision,
            "blocked",
            `The supervisor reported ${check} fixed but left uncommitted changes. ` +
                "Review and commit them, then resume the checks.",
        )
        return
    }

    supervision.status = "checking"
    try {
        startChecks({
            branch: supervision.branch,
            base: supervision.base,
            resume: true,
            previous: findCombinedBranch(supervision.branch)?.checks ?? null,
            onFinished: (report) => checked(supervision, report),
        })
        announceChange("tasks")
    } catch (caught) {
        settle(
            supervision,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
    }
}

onRunSettled(supervisorSettled)
