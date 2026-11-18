import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { workspace } from "./config/paths"
import { aioVrAvailable, spawnAioVr } from "./aiovr"

/**
 * Throwaway scenarios: drive the app, print what it logged, keep nothing.
 *
 * This is the exploration hatch. A checkpoint answers "did my change move
 * anything?" and a baseline answers "does the app still look the way we
 * agreed?" — both are records, and both are meant to last. A scratch scenario
 * is neither. It exists so an agent (or a person) can reach some state that
 * takes five steps to get to, drop a `console.log` into the app, and read the
 * output, without any of it becoming evidence attached to a task.
 *
 * The isolation is aio-vr's, not ours: scratch scenarios live in
 * `.aio-vr/scratch/`, a *sibling* of `scenarios/`, and normal discovery only
 * ever reads `scenarios/`. So nothing written here can fail the suite, be
 * captured into a checkpoint, or be promoted into a baseline — which is what
 * makes it safe to hand to an agent that is guessing.
 */

export interface ScratchPaths {
    /** Where the `.cjs` scenario files live. */
    rootDirectory: string
    /** Screenshots and `results.json` from the last run. */
    outputDirectory: string
    /** Per-run artifacts, including the console and network transcripts. */
    runsDirectory: string
}

/** Mirrors aio-vr's own `createScratchPaths`, which owns this layout. */
export function scratchPaths(): ScratchPaths {
    const rootDirectory = join(workspace().aioVrDir, "scratch")
    const outputDirectory = join(rootDirectory, "out")

    return {
        rootDirectory,
        outputDirectory,
        runsDirectory: join(outputDirectory, "runs"),
    }
}

const SCENARIO_EXTENSIONS = new Set([".js", ".cjs", ".mjs"])

/** Names only — the file extension is aio-vr's business, not the caller's. */
export async function listScratchScenarios(): Promise<string[]> {
    const { rootDirectory } = scratchPaths()

    let entries
    try {
        entries = await readdir(rootDirectory, { withFileTypes: true })
    } catch {
        return []
    }

    return entries
        .filter(
            (entry) =>
                entry.isFile() && SCENARIO_EXTENSIONS.has(extname(entry.name)),
        )
        .map((entry) => basename(entry.name, extname(entry.name)))
        .sort((left, right) => left.localeCompare(right))
}

export interface ScratchLog {
    scenario: string
    path: string
    text: string
}

/**
 * A transcript the last run left for a scenario, if it produced one.
 *
 * `scratch run` streams both of these as they happen, so reading them back is
 * for the case where the run has already scrolled past — which, for an agent
 * reading a truncated tool result, is most of the time.
 */
async function readScratchLog(
    scenario: string,
    kind: "console" | "network",
): Promise<ScratchLog | null> {
    const path = join(scratchPaths().runsDirectory, `${scenario}.${kind}.log`)
    if (!existsSync(path)) return null

    return { scenario, path, text: await readFile(path, "utf8") }
}

/** What the page logged: `console.log`/`warn`/`error` and uncaught exceptions. */
export const readScratchConsoleLog = (
    scenario: string,
): Promise<ScratchLog | null> => readScratchLog(scenario, "console")

/** The API calls the page made, with status, timing and both bodies. */
export const readScratchNetworkLog = (
    scenario: string,
): Promise<ScratchLog | null> => readScratchLog(scenario, "network")

function requireAioVr(): void {
    if (aioVrAvailable()) return
    throw new Error(
        "Could not find aio-vr on PATH. Install aio-visual-regression, or set AIO_VR_BIN.",
    )
}

export interface ScratchRunResult {
    exitCode: number
    /** Combined stdout+stderr, empty when the run streamed to the terminal. */
    output: string
    /** One transcript per scenario that logged anything, for `--json` callers. */
    consoleLogs: ScratchLog[]
    /** The same, for the API calls each scenario made. */
    networkLogs: ScratchLog[]
}

export interface ScratchRunOptions {
    scenarios?: string[]
    /** Show the browser window rather than running headless. */
    headed?: boolean
    /** Stream aio-vr's output — including the live echo — to stdout. */
    inheritStdio?: boolean
    /**
     * URL globs to record API calls for, overriding the default `/api/**`. An app
     * that serves its API from somewhere else needs this, and so does anyone who
     * wants to watch traffic that is not an API call at all.
     */
    requests?: string[]
    /** Show response bodies for successful calls too, not only failed ones. */
    bodies?: boolean
    /** Skip API capture, for a page whose traffic is pure noise. */
    noRequests?: boolean
}

export async function runScratch(
    options: ScratchRunOptions = {},
): Promise<ScratchRunResult> {
    requireAioVr()

    const args = ["scratch", "run", ...(options.scenarios ?? [])]
    if (options.headed) args.push("--headed")
    if (options.bodies) args.push("--bodies")
    if (options.noRequests) args.push("--no-requests")
    for (const glob of options.requests ?? []) args.push("--requests", glob)

    const { exitCode, output } = await spawnAioVr(
        args,
        options.inheritStdio !== false,
    )

    // Which scenarios actually ran is aio-vr's decision (bare `run` means all of
    // them), so the transcripts are collected by looking at what is on disk
    // afterwards rather than by trusting the request.
    const wanted = options.scenarios?.length
        ? options.scenarios
        : await listScratchScenarios()
    const consoleLogs: ScratchLog[] = []
    const networkLogs: ScratchLog[] = []

    for (const scenario of wanted) {
        const consoleLog = await readScratchConsoleLog(scenario)
        if (consoleLog) consoleLogs.push(consoleLog)

        const networkLog = await readScratchNetworkLog(scenario)
        if (networkLog) networkLogs.push(networkLog)
    }

    return { exitCode, output, consoleLogs, networkLogs }
}

export interface ScratchNewResult {
    scenario: string
    /** Absolute path to the scaffolded file, for the caller to open. */
    path: string
    output: string
}

export async function newScratch(
    scenario: string,
    baseUrl?: string,
): Promise<ScratchNewResult> {
    requireAioVr()

    const args = ["scratch", "new", scenario]
    if (baseUrl) args.push("--url", baseUrl)

    const { exitCode, output } = await spawnAioVr(args, false)
    if (exitCode !== 0)
        throw new Error(
            `aio-vr scratch new failed.${output ? `\n\n${output.trim()}` : ""}`,
        )

    return {
        scenario,
        path: join(scratchPaths().rootDirectory, `${scenario}.cjs`),
        output,
    }
}

/** `all` deletes the scenario files too, not just what the last run produced. */
export async function cleanScratch(all: boolean): Promise<string> {
    requireAioVr()

    const args = ["scratch", "clean"]
    if (all) args.push("--all")

    const { exitCode, output } = await spawnAioVr(args, false)
    if (exitCode !== 0)
        throw new Error(
            `aio-vr scratch clean failed.${output ? `\n\n${output.trim()}` : ""}`,
        )

    return output
}

export interface ProbeOptions {
    url: string
    /** CSS selector to wait for before the screenshot — a page, not a timeout. */
    waitFor?: string
    /** Write the screenshot here instead of into the scratch output folder. */
    out?: string
    headed?: boolean
    inheritStdio?: boolean
    requests?: string[]
    bodies?: boolean
    noRequests?: boolean
}

/**
 * One-off screenshot of a URL, with no scenario file to create or clean up.
 * The fast path when the state is reachable by navigating to it; a scratch
 * scenario is for when getting there takes several steps.
 */
export async function runProbe(
    options: ProbeOptions,
): Promise<{ exitCode: number; output: string }> {
    requireAioVr()

    const args = ["probe", "--url", options.url]
    if (options.waitFor) args.push("--wait-for", options.waitFor)
    if (options.out) args.push("--out", options.out)
    if (options.headed) args.push("--headed")
    if (options.bodies) args.push("--bodies")
    if (options.noRequests) args.push("--no-requests")
    for (const glob of options.requests ?? []) args.push("--requests", glob)

    return spawnAioVr(args, options.inheritStdio !== false)
}
