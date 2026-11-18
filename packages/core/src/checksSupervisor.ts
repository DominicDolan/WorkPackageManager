import {
    continueRun,
    findAgentRun,
    unattendedSupervisor,
    onRunSettled,
    runResult,
    runUsageLimit,
    startRun,
    stopRun,
    supervisorVerdict,
} from "./agents"
import { startChecks } from "./checks"
import { findCombinedBranch } from "./repo"
import { announceChange } from "./watch"
import { workspace } from "./config/paths"
import { checkPassed } from "@work-task-manager/shared/checks"
import {
    MAX_SUPERVISIONS_PER_CHECK,
    checksSupervisionActive,
    type AgentRun,
    type AgentRunStatus,
    type CheckRun,
    type ChecksReport,
    type ChecksSupervision,
    type ChecksSupervisionStatus,
    type RunSupervisor,
} from "@work-task-manager/shared"

/**
 * Pre-PR checks with a supervisor standing by.
 *
 * The same idea as a work package run's supervisor, applied to the checks: the
 * suite stops at its first failure, and instead of waiting for a person the
 * failure goes to a headless agent to fix. The agent does not run the check
 * itself to prove its fix; it commits and ends on `RESOLVED`, and this runs
 * the failing check again, alone. If it still fails, the same agent's session
 * is carried on with the new output, so what it learned the first time is not
 * lost. Once it passes, the rest of the suite resumes. Resume keeps passes
 * only for the same commit, so after a committed fix every other check runs
 * again against the new head.
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
    attempts: Attempt[]
    /** The supervisor at work right now, if any. */
    currentAgentId: number | null
    /** The check being run again alone after a supervisor's fix, if any. */
    recheck: string | null
}

interface Attempt {
    check: string
    calledFor: string
    agentRunId: number
    /** What it was called in on, so a resume that fails can be handed to a
     *  fresh supervisor instead. */
    report: ChecksReport
    failure: CheckRun
    /** Whether it carried an earlier supervisor's session on. */
    continued: boolean
    /** A resume that failed and was replaced by a fresh supervisor. It did no
     *  work, so it does not count towards the per-check cap. */
    replaced: boolean
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
                              sessionId: agent.sessionId,
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
        recheck: null,
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

    const recheck = supervision.recheck
    supervision.recheck = null
    const rechecked = recheck
        ? report.checks.find((run) => run.name === recheck)
        : undefined
    if (rechecked && checkPassed(rechecked)) {
        // The fix took. The rest of the suite runs once, against this commit.
        runAgain(supervision, { resume: true, previous: report })
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

    const earlier = attemptsOn(supervision, failure.name)
    if (earlier.length >= MAX_SUPERVISIONS_PER_CHECK) {
        settle(
            supervision,
            "blocked",
            `${failure.name} still fails after the supervisor was called in ${earlier.length} times, ` +
                "so it is left for a person.",
        )
        return
    }

    // The same check failing again goes back to the agent that worked on it,
    // when its conversation can be carried on. A new check gets a fresh agent.
    const previous = earlier.at(-1)
    callSupervisor(
        supervision,
        report,
        failure,
        previous && findAgentRun(previous.agentRunId)?.sessionId
            ? previous
            : null,
    )
}

/** The supervisors that count as having been called in on a check. */
function attemptsOn(supervision: Supervision, check: string): Attempt[] {
    return supervision.attempts.filter(
        (attempt) => attempt.check === check && !attempt.replaced,
    )
}

/**
 * Put a supervisor to work on a failure: carry on `previous`'s session when
 * given one, or start a fresh agent with the reports so far. A resume that
 * cannot be launched falls back to a fresh agent.
 */
function callSupervisor(
    supervision: Supervision,
    report: ChecksReport,
    failure: CheckRun,
    previous: Attempt | null,
    /** Set when this replaces a resume that failed, to say so in the UI. */
    replacing = false,
): void {
    const { supervisor } = supervision
    let run: AgentRun | null = null
    let continued = false
    if (previous) {
        try {
            run = continueRun({
                runId: previous.agentRunId,
                model: supervisor.model,
                permissionMode: supervisor.permissionMode,
                prompt: followUp(report, failure),
            })
            continued = true
        } catch (caught) {
            // Logged rather than shown: the fresh supervisor carries on.
            console.error(
                `could not resume supervisor ${previous.agentRunId} on '${supervision.branch}', starting a fresh one:`,
                caught,
            )
        }
    }
    try {
        run ??= startRun({
            harness: supervisor.harness,
            model: supervisor.model,
            mode: "print",
            command: "supervise-checks",
            target: supervision.branch,
            extra: supervisor.extra,
            subjectKind: "branch",
            subjectRef: supervision.branch,
            permissionMode: supervisor.permissionMode,
            handoff: brief(
                report,
                failure,
                attemptsOn(supervision, failure.name),
            ),
        })
    } catch (caught) {
        settle(
            supervision,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
        return
    }
    supervision.attempts.push({
        check: failure.name,
        calledFor: continued
            ? `${describeFailure(failure)} Still failing after its fix, so its session carried on.`
            : replacing
              ? `${describeFailure(failure)} Resuming the last supervisor failed, so a fresh one took over.`
              : describeFailure(failure),
        agentRunId: run.id,
        report,
        failure,
        continued,
        replaced: false,
    })
    supervision.currentAgentId = run.id
    supervision.status = "fixing"
    announceChange("tasks")
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
        ...failureDetails(failure),
    ]
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

/** The message that carries a supervisor's session on when the check it
 *  fixed still fails. It has the instructions already; this is the result. */
function followUp(report: ChecksReport, failure: CheckRun): string {
    return [
        `The checks run re-ran \`${failure.name}\` against commit ` +
            `${report.headSha ?? "(unknown)"} after your fix, and it still fails.`,
        "",
        ...failureDetails(failure),
        "",
        "Carry on under the same instructions: find out why, commit a fix on the " +
            "branch, and end with your report. Its last line must be `RESOLVED` " +
            "for the check to be run again, or `UNRESOLVED` if it needs a person.",
    ].join("\n")
}

/** The failing check's command, result and output, as the supervisor reads them. */
function failureDetails(failure: CheckRun): string[] {
    const output =
        failure.output.length > BRIEF_OUTPUT_CHARS
            ? `… earlier output omitted …\n${failure.output.slice(-BRIEF_OUTPUT_CHARS)}`
            : failure.output
    const lines = [
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
    return lines
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

    const attempt = supervision.attempts.find(
        (one) => one.agentRunId === agentRunId,
    )
    const check = attempt?.check ?? "the check"
    if (status === "stopped") {
        settle(
            supervision,
            "stopped",
            `The supervisor on ${check} was stopped, so the checks stopped with it.`,
        )
        return
    }
    const limit = runUsageLimit(agentRunId)
    if (limit) {
        settle(
            supervision,
            "blocked",
            `The supervisor reached Claude's ${limit.type.replaceAll("_", " ")} usage limit. Reset: ${new Date(limit.resetsAt * 1000).toLocaleString()}. Resume the checks after the limit resets.`,
        )
        return
    }
    // A resume that errored most likely never got going: the session could
    // not be found, or the harness would not take it headless. A fresh
    // supervisor gets the same failure instead of the run stopping.
    if (status === "failed" && attempt?.continued) {
        attempt.replaced = true
        callSupervisor(supervision, attempt.report, attempt.failure, null, true)
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
    // No verdict counts as unresolved, but says so: an agent that stopped
    // mid-job is not one that tried and gave up.
    const verdict = supervisorVerdict(agentRunId)
    if (verdict === null) {
        settle(
            supervision,
            "blocked",
            `The supervisor on ${check} ended without a verdict, so it may have stopped before ` +
                "finishing. Check its output and the working tree, then resume the checks.",
        )
        return
    }
    if (verdict !== "resolved") {
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

    // The supervisor was told not to run the check itself to prove the fix:
    // this run is the one that counts. Just that check first, so a fix that
    // did not take goes straight back to it rather than after the whole suite.
    const previous = findCombinedBranch(supervision.branch)?.checks ?? null
    if (attempt) {
        supervision.recheck = attempt.check
        runAgain(supervision, { check: attempt.check, previous })
    } else {
        runAgain(supervision, { resume: true, previous })
    }
}

/** Start the next pass of the checks under this supervision. */
function runAgain(
    supervision: Supervision,
    pass: { check?: string; resume?: boolean; previous: ChecksReport | null },
): void {
    supervision.status = "checking"
    try {
        startChecks({
            branch: supervision.branch,
            base: supervision.base,
            ...pass,
            onFinished: (report) => checked(supervision, report),
        })
        announceChange("tasks")
    } catch (caught) {
        supervision.recheck = null
        settle(
            supervision,
            "failed",
            caught instanceof Error ? caught.message : String(caught),
        )
    }
}

onRunSettled(supervisorSettled)
