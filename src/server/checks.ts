import { resolve, sep } from "node:path"
import { existsSync } from "node:fs"
import { workspace } from "../config/paths"
import type { CheckDefinition } from "../config/config"
import type { CheckRun, ChecksProgress, ChecksReport } from "../shared/types"
import { planChecks } from "../shared/checks"
import { findCombinedBranch, updateCombinedBranch } from "./repo"
import { announceChange } from "./watch"

/**
 * The repository's own pre-PR checks — typecheck, lint, unit tests — run from
 * here so a branch is only offered to `gh pr create` after the things CI is
 * about to run have already passed locally.
 *
 * Nothing about which checks exist is known here: a check is a command, a
 * working directory and (optionally) the paths it cares about, all declared in
 * `checks` in tasks.config.json. That is what lets one tool serve a Vue
 * frontend, a .NET backend and a Bun CLI sitting in one repository without
 * knowing anything about any of them.
 *
 * Like everything else that shells out for a web request, checks run detached
 * from any terminal and under a hard timeout — `bun run lint` prompting for
 * input, or a test runner waiting on a watcher, must not hold the request open.
 */

const ws = workspace()

/** Generous, because a cold `dotnet build` or a full unit suite is minutes, not
 *  seconds. Per-check `timeoutMs` overrides it. */
const DEFAULT_TIMEOUT_MS = 900_000

/** How much of a check's output to keep. Failures are read from the bottom —
 *  the summary line and the first error above it — so the tail is what's kept. */
const OUTPUT_LIMIT = 20_000

export function configuredChecks(): CheckDefinition[] {
    return ws.config.checks
}

/* -------------------------------------------------------- path filtering */

/**
 * Match one repo-relative file path against one config pattern.
 *
 * Supports `**` (any number of segments), `*` (within a segment) and a bare
 * prefix: `frontend` matches everything under `frontend/`, which is the form
 * anyone actually writes for a monorepo folder.
 */
function matches(path: string, pattern: string): boolean {
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "")
    if (!clean) return false

    // A pattern with no wildcard is a directory (or file) prefix.
    if (!clean.includes("*"))
        return path === clean || path.startsWith(`${clean}/`)

    const regex = new RegExp(
        `^${clean
            .split(/(\*\*\/|\*\*|\*)/)
            .map((part) => {
                if (part === "**/") return "(?:[^/]+/)*"
                if (part === "**") return ".*"
                if (part === "*") return "[^/]*"
                return part.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
            })
            .join("")}$`,
    )
    return regex.test(path)
}

/* --------------------------------------------------------------- running */

interface Ran {
    code: number
    output: string
    timedOut: boolean
    /** Set when the command could not be started at all — a typo'd binary, or one
     *  that is simply not installed on this machine. */
    unrunnable?: string
}

/** Strip ANSI escapes. `FORCE_COLOR=0` persuades most tools, but plenty write
 *  colour unconditionally, and raw `\x1b[31m` in the UI's output pane is worse
 *  than no colour at all. */
function plain(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

/**
 * Run one command and wait for it, without blocking the event loop.
 *
 * Deliberately not `spawnSync`: a check suite is minutes, and a synchronous
 * spawn would freeze the whole server — every other request, the live-update
 * stream and the progress this very run is reporting — until it finished.
 */
async function run(
    command: string[],
    cwd: string,
    timeoutMs: number,
    extraEnv: Record<string, string>,
): Promise<Ran> {
    let child
    try {
        child = Bun.spawn(command, {
            cwd,
            // Never inherit stdio: an interactive prompt would hang the run.
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: timeoutMs,
            env: { ...process.env, CI: "true", FORCE_COLOR: "0", ...extraEnv },
        })
    } catch (error) {
        // Bun throws rather than returning an exit code when the executable does
        // not exist. Reported as this one check's problem: letting it escape would
        // take the whole run down and lose every other check's result with it.
        return {
            code: 1,
            output: "",
            timedOut: false,
            unrunnable: error instanceof Error ? error.message : String(error),
        }
    }

    // Drained concurrently with waiting: a check that fills the pipe buffer while
    // nothing reads it deadlocks, and a verbose test suite fills it easily.
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ])
    await child.exited

    const combined = [plain(stdout), plain(stderr)]
        .filter((part) => part.trim())
        .join("\n")

    return {
        code: child.exitCode ?? 1,
        output:
            combined.length > OUTPUT_LIMIT
                ? `… ${combined.length - OUTPUT_LIMIT} earlier characters omitted …\n${combined.slice(-OUTPUT_LIMIT)}`
                : combined,
        // Bun reports a timeout kill as a signal rather than an exit code.
        timedOut:
            child.signalCode === "SIGTERM" || child.signalCode === "SIGKILL",
    }
}

const git = (args: string[]): { code: number; stdout: string } => {
    const result = Bun.spawnSync(["git", ...args], {
        cwd: ws.repoRoot,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    return { code: result.exitCode ?? 1, stdout: result.stdout.toString() }
}

/** The files this branch changes relative to its base — `...` so a base that has
 *  moved on since the branch was cut does not drag unrelated files in. */
function changedFiles(branch: string, base: string): string[] | null {
    const result = git(["diff", "--name-only", `${base}...${branch}`])
    if (result.code !== 0) return null
    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
}

export function headSha(branch: string): string | null {
    const result = git(["rev-parse", branch])
    return result.code === 0 && result.stdout.trim()
        ? result.stdout.trim()
        : null
}

/**
 * Run the configured checks (or one selected check) against a branch and
 * report. A selected result is merged with prior results for the same commit.
 *
 * The branch is *not* checked out: checks run against the working tree as it
 * stands, which is the normal case (you are on the branch you are about to open
 * a PR from) and the only safe one — switching branches under a user who has
 * uncommitted work is not something a web request gets to do. When the working
 * tree is on some other branch the report says so, and the caller decides
 * whether that makes the result meaningless.
 */
export async function runChecks(input: {
    branch: string
    base: string
    /** Run only this named check. Omit to run the complete suite. */
    check?: string
    /** Retry failed checks and run missing checks, retaining current passes. */
    resume?: boolean
    /** Results to retain when rerunning one check against the same commit. */
    previous?: ChecksReport | null
    /** Called as each check starts, so a caller can say what is happening. */
    onProgress?: (current: string, done: number, total: number) => void
    /** Called after every completed check, including skipped or invalid checks. */
    onCheckComplete?: (run: CheckRun, done: number, total: number) => void
    onPlan?: (names: string[], retained: CheckRun[]) => void
}): Promise<ChecksReport> {
    const {
        branch,
        base,
        check,
        resume,
        previous,
        onProgress,
        onCheckComplete,
    } = input
    const definitions = configuredChecks()
    if (check && !definitions.some((definition) => definition.name === check))
        throw new Error(`Unknown check '${check}'.`)

    const onBranch = git(["branch", "--show-current"]).stdout.trim()
    const touched = changedFiles(branch, base)
    // Capture this before running. If the branch moves during a long check, the
    // finished report is stale instead of accidentally describing the new head.
    const checkedHead = headSha(branch)
    const plan = planChecks({
        names: definitions.map((item) => item.name),
        branch,
        base,
        headSha: checkedHead,
        check,
        resume,
        previous,
    })
    const selected = definitions.filter((item) =>
        plan.selected.includes(item.name),
    )
    input.onPlan?.(plan.selected, plan.retained)

    const freshRuns: CheckRun[] = []

    // Sequential, not parallel: these are builds and test suites, and running six
    // of them at once on one machine makes all six slower and the output useless.
    for (const [index, definition] of selected.entries()) {
        // Announced from inside, immediately before the command is spawned, so a
        // check that turns out to be skipped is never reported as running.
        const run = await runOne(definition, { branch, base, touched }, () =>
            onProgress?.(definition.name, index, selected.length),
        )
        freshRuns.push(run)
        onCheckComplete?.(run, freshRuns.length, selected.length)

        // A failed command, timeout, or configuration error makes the suite
        // fail. There is no value in continuing to consume time and obscuring
        // the first actionable failure with later results.
        if (
            run.status === "failed" ||
            run.status === "timed_out" ||
            run.status === "error"
        )
            break
    }

    // Reruns and resumes retain eligible results for this same branch commit.
    const byName = new Map(
        [...plan.retained, ...freshRuns].map((run) => [run.name, run]),
    )
    const runs = definitions.flatMap((definition) => {
        const run = byName.get(definition.name)
        return run ? [run] : []
    })
    const complete = runs.length === definitions.length

    return {
        branch,
        base,
        headSha: checkedHead,
        ranAt: new Date().toISOString(),
        // Skips pass: a check that watches `frontend/**` on a backend-only branch
        // has nothing to say, and treating silence as failure would make the gate
        // useless in exactly the repositories path filters exist for.
        passed:
            complete &&
            runs.every(
                (check) =>
                    check.status === "passed" || check.status === "skipped",
            ),
        ranOnBranch: onBranch || null,
        checks: runs,
    }
}

async function runOne(
    definition: CheckDefinition,
    context: { branch: string; base: string; touched: string[] | null },
    onStart: () => void,
): Promise<CheckRun> {
    const { branch, base, touched } = context

    const cwd = resolve(ws.repoRoot, definition.cwd ?? ".")
    const base_: CheckRun = {
        name: definition.name,
        command: definition.command,
        cwd: definition.cwd ?? ".",
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        output: "",
    }

    if (!existsSync(cwd)) {
        // Misconfiguration is an error, not a skip: a check nobody can run must
        // never be mistaken for a check with nothing to say.
        return {
            ...base_,
            status: "error",
            reason: `Working directory '${definition.cwd}' does not exist.`,
        }
    }
    // Refuse a cwd outside the repository: a check is the repo's own build, and
    // a config typo should not run a command somewhere else entirely.
    const root = ws.repoRoot.endsWith(sep) ? ws.repoRoot : ws.repoRoot + sep
    if (cwd !== ws.repoRoot && !cwd.startsWith(root)) {
        return {
            ...base_,
            status: "error",
            reason: `Working directory '${definition.cwd}' is outside the repository.`,
        }
    }

    if (definition.paths?.length) {
        if (touched === null) {
            return {
                ...base_,
                status: "error",
                reason: `Could not diff '${branch}' against '${base}', so its paths could not be matched.`,
            }
        }
        const relevant = touched.some((file) =>
            definition.paths!.some((p) => matches(file, p)),
        )
        if (!relevant) {
            return {
                ...base_,
                reason: "Nothing on this branch touches the paths it watches.",
            }
        }
    }

    onStart()
    const started = Date.now()
    const result = await run(
        definition.command,
        cwd,
        definition.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        {
            // What a check cannot work out for itself. The branch under test is not
            // necessarily the checked-out one (see `runChecks`), and nothing on disk
            // records which base it is meant to be compared against — so a check about
            // the *shape* of a branch, rather than the contents of the tree, has no way
            // to ask. Named for the tool rather than the repo: these are as much part of
            // the contract as the exit code is.
            TASKS_BRANCH: branch,
            TASKS_BASE: base,
            TASKS_REPO_ROOT: ws.repoRoot,
        },
    )
    if (result.unrunnable) {
        return {
            ...base_,
            status: "error",
            reason: result.unrunnable,
            durationMs: Date.now() - started,
        }
    }
    return {
        ...base_,
        status: result.timedOut
            ? "timed_out"
            : result.code === 0
              ? "passed"
              : "failed",
        exitCode: result.code,
        durationMs: Date.now() - started,
        output: result.output,
    }
}

/**
 * Why a report is not good enough to open a PR on, or null when it is.
 *
 * Staleness is by commit: a report is about the code that was on the branch when
 * it ran, and one more commit makes it a statement about something else.
 */
export function checksBlockingPr(
    report: ChecksReport | null,
    branch: string,
): string | null {
    if (!configuredChecks().length) return null
    if (!report) return "Checks have not been run on this branch yet."
    const completed = new Set(report.checks.map((check) => check.name))
    const missing = configuredChecks().filter(
        (definition) => !completed.has(definition.name),
    )
    if (missing.length)
        return `Checks have not been run: ${missing.map((check) => check.name).join(", ")}.`
    if (!report.passed) {
        const failed = report.checks.filter(
            (check) => check.status !== "passed" && check.status !== "skipped",
        )
        return `Checks failed: ${failed.map((check) => check.name).join(", ")}.`
    }

    const current = headSha(branch)
    if (current && report.headSha && current !== report.headSha) {
        return "The branch has new commits since the checks last ran."
    }
    return null
}

/* ---------------------------------------------------- background running */

/**
 * Runs in flight, by branch.
 *
 * Checks are started and left running rather than awaited inside the request
 * that asked for them, because a suite outlives any HTTP request worth holding
 * open: Bun caps a server's idle timeout at 255 seconds, and a cold release
 * build plus a test suite goes past that on its own. The request starts the run
 * and returns; the page follows it here, and the stored report is what everyone
 * reads at the end.
 */
const inFlight = new Map<string, ChecksProgress>()

export function checksProgress(branch: string): ChecksProgress | null {
    return inFlight.get(branch) ?? null
}

/**
 * Start a run for a branch, or return the one already going.
 *
 * The result is persisted against the branch when it finishes, and the change is
 * announced so open pages refresh themselves rather than polling for an answer
 * that has already arrived.
 */
export function startChecks(input: {
    branch: string
    base: string
    check?: string
    resume?: boolean
    previous?: ChecksReport | null
}): ChecksProgress {
    const { branch, base, check, resume, previous } = input
    if (check && !configuredChecks().some((item) => item.name === check))
        throw new Error(`Unknown check '${check}'.`)

    const existing = inFlight.get(branch)
    if (existing) return existing

    const progress: ChecksProgress = {
        branch,
        base,
        startedAt: new Date().toISOString(),
        current: null,
        currentStartedAt: null,
        names: [],
        done: 0,
        total: check ? 1 : configuredChecks().length,
        checks: [],
    }
    inFlight.set(branch, progress)

    void runChecks({
        branch,
        base,
        check,
        resume,
        previous,
        onPlan: (names, retained) => {
            progress.names = names
            progress.total = names.length
            progress.checks = [...retained]
        },
        onProgress: (current, done, total) => {
            progress.current = current
            progress.currentStartedAt = new Date().toISOString()
            progress.done = done
            progress.total = total
        },
        onCheckComplete: (run, done, total) => {
            progress.current = null
            progress.currentStartedAt = null
            progress.checks.push(run)
            progress.done = done
            progress.total = total
        },
    })
        .then((report) => {
            // Only a registered delivery branch has somewhere to store the result. An
            // ad-hoc branch still gets checked; it just does not gate anything.
            if (findCombinedBranch(branch))
                updateCombinedBranch(branch, { checks: report })
        })
        .catch((error: unknown) => {
            // Nothing above should throw — a failing check is a result, not an
            // exception — but a run that died must not leave the branch looking busy
            // forever, and the reason belongs somewhere a person can find it.
            console.error(`checks failed to run on '${branch}':`, error)
        })
        .finally(() => {
            inFlight.delete(branch)
            announceChange("tasks")
        })

    return progress
}
