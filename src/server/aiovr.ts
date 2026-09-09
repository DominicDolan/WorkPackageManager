import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { workspace } from "../config/paths"
import { latestRun, recordRun, type RecordRunInput } from "./repo"
import {
  checkpointNameFor,
  type Comparison,
  type Phase,
  type Task,
} from "../shared/types"

/**
 * Drives the aio-vr CLI and folds what it produced back into the database.
 *
 * The checkpoint directory on disk stays the source of truth: `before` writes
 * `meta.json`, `after` writes `results.json`, and `after --json` prints that
 * same results file verbatim. So rather than parse stdout — which also carries
 * human-facing progress lines — both phases read the JSON off disk.
 */

/** The executable to drive. Per-repo via config, overridable per-run by env. */
const aioVrBin = (): string =>
  process.env.AIO_VR_BIN ?? workspace().config.aioVrBin

/** A task's checkpoint name, falling back to the one its ref would generate. */
export const checkpointNameOf = (task: Task): string =>
  task.checkpointName ??
  checkpointNameFor(task.ref, workspace().config.checkpointPrefix)

export interface CheckpointOptions {
  /** Limit to these scenario names (repeatable `--scenario`). */
  scenarios?: string[]
  /** Limit to these scenario folders (repeatable `--folder`). */
  folders?: string[]
  /** `after` only: treat diffs at or below this percentage as unchanged. */
  minPercent?: number
  /** `after` only: don't fail when the scenario set drifted since `before`. */
  allowMissing?: boolean
  /** Stream aio-vr's output to this process's stdout. */
  inheritStdio?: boolean
}

export interface CheckpointResult {
  runId: number
  phase: Phase
  checkpointName: string
  exitCode: number
  comparisons: Omit<Comparison, "id" | "runId">[]
  /** Combined stdout+stderr, empty when stdio was inherited. */
  output: string
}

interface CheckpointMeta {
  createdAt: string
  gitHead?: string | null
  gitDirty?: boolean
  name: string
  scenarios: {
    name: string
    scenarioPath: string
    viewport?: { width: number; height: number }
  }[]
}

interface ResultsFile {
  generatedAt?: string
  results?: {
    name: string
    description?: string
    status: string
    percentChanged?: number
    pixelDiffCount?: number
    totalPixels?: number
    actualPath?: string
    baselinePath?: string
    diffPath?: string
    browserLogStatus?: string
    browserLogChangeCount?: number
  }[]
}

export function checkpointDir(name: string): string {
  return join(workspace().aioVrDir, "checkpoints", name)
}

/** Where `before` stored a scenario's reference image. */
function beforeImagePath(name: string, scenario: string): string | null {
  const absolute = join(checkpointDir(name), "images", `${scenario}.png`)
  if (!existsSync(absolute)) return null
  return relative(workspace().repoRoot, absolute)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

export function aioVrAvailable(): boolean {
  return Bun.which(aioVrBin()) !== null
}

export function checkpointExists(name: string): boolean {
  return existsSync(join(checkpointDir(name), "meta.json"))
}

/** Remove screenshots aio-vr no longer needs for one task checkpoint. */
export async function cleanCheckpoint(task: Task): Promise<void> {
  const name = checkpointNameOf(task)
  // A task can reach the end of its life without ever capturing a checkpoint —
  // nothing visual to compare, or the work turned out to need no change at all.
  // There is nothing to clean then, and aio-vr would exit non-zero.
  if (!checkpointExists(name)) return
  if (!aioVrAvailable()) {
    throw new Error(
      `Could not find the '${aioVrBin()}' executable on PATH. Install aio-visual-regression, or set AIO_VR_BIN.`,
    )
  }
  const { exitCode, output } = await spawnAioVr(
    ["clean", "--name", name],
    false,
  )
  if (exitCode !== 0)
    throw new Error(
      `aio-vr clean failed for ${task.ref}.${output ? `\n\n${output.trim()}` : ""}`,
    )
}

/** The scenario filters a run was launched with, or null when it ran the whole suite. */
function selectionOf(
  options: CheckpointOptions,
): { scenarios?: string[]; folders?: string[] } | null {
  const scenarios = options.scenarios?.length ? options.scenarios : undefined
  const folders = options.folders?.length ? options.folders : undefined
  return scenarios || folders ? { scenarios, folders } : null
}

function buildArgs(
  phase: Phase,
  name: string,
  options: CheckpointOptions,
): string[] {
  const args = [phase, "--name", name]

  for (const scenario of options.scenarios ?? [])
    args.push("--scenario", scenario)
  for (const folder of options.folders ?? []) args.push("--folder", folder)

  if (phase === "after") {
    if (options.minPercent !== undefined)
      args.push("--min-percent", String(options.minPercent))
    if (options.allowMissing) args.push("--allow-missing")
  }

  return args
}

/** Exported so the baselines module can drive `run` and `approve` through the
 *  same executable resolution and environment as checkpoint captures. */
export async function spawnAioVr(
  args: string[],
  inheritStdio: boolean,
): Promise<{ exitCode: number; output: string }> {
  const { repoRoot } = workspace()

  const proc = Bun.spawn([aioVrBin(), ...args], {
    cwd: repoRoot,
    stdout: inheritStdio ? "inherit" : "pipe",
    stderr: inheritStdio ? "inherit" : "pipe",
    env: { ...process.env },
  })

  const output = inheritStdio
    ? ""
    : [
        await new Response(proc.stdout).text(),
        await new Response(proc.stderr).text(),
      ]
        .filter(Boolean)
        .join("\n")

  return { exitCode: await proc.exited, output }
}

/**
 * Capture the "before" state for a task. Every scenario's reference image is
 * recorded immediately, so the web app can show the starting state while the
 * work is still in progress.
 */
export async function captureBefore(
  task: Task,
  options: CheckpointOptions = {},
): Promise<CheckpointResult> {
  const name = checkpointNameOf(task)
  if (!aioVrAvailable()) {
    throw new Error(
      `Could not find the '${aioVrBin()}' executable on PATH. Install aio-visual-regression, or set AIO_VR_BIN.`,
    )
  }

  const { exitCode, output } = await spawnAioVr(
    buildArgs("before", name, options),
    options.inheritStdio ?? false,
  )

  const meta = await readJson<CheckpointMeta>(
    join(checkpointDir(name), "meta.json"),
  )
  if (!meta) {
    throw new Error(
      `aio-vr exited ${exitCode} without writing a checkpoint. Output:\n${output || "(streamed above)"}`,
    )
  }

  // `before` writes results.json too, so a later `after` cannot tell a fresh
  // file from this one by content alone — see the staleness check there.
  const selection = selectionOf(options)

  const comparisons = meta.scenarios.map((scenario) => ({
    scenario: scenario.name,
    description: null,
    // A `before` capture has nothing to compare against yet; it is the reference.
    status: "new-baseline" as const,
    percentChanged: null,
    pixelDiffCount: null,
    totalPixels: null,
    beforePath: beforeImagePath(name, scenario.name),
    afterPath: null,
    diffPath: null,
    browserLogStatus: null,
    browserLogChangeCount: null,
  }))

  const run: RecordRunInput = {
    taskId: task.id,
    checkpointName: name,
    phase: "before",
    exitCode,
    gitHead: meta.gitHead ?? null,
    gitDirty: meta.gitDirty ?? null,
    scenarioCount: comparisons.length,
    selection,
    raw: meta,
    comparisons,
  }

  return {
    runId: recordRun(run),
    phase: "before",
    checkpointName: name,
    exitCode,
    comparisons,
    output,
  }
}

/**
 * Re-run the scenarios and diff them against the task's checkpoint. This is
 * idempotent — `after` always compares against the fixed reference — so it can
 * be re-run as many times as the work needs.
 */
export async function captureAfter(
  task: Task,
  options: CheckpointOptions = {},
): Promise<CheckpointResult> {
  const name = checkpointNameOf(task)
  if (!aioVrAvailable()) {
    throw new Error(
      `Could not find the '${aioVrBin()}' executable on PATH. Install aio-visual-regression, or set AIO_VR_BIN.`,
    )
  }
  if (!checkpointExists(name)) {
    throw new Error(
      `No '${name}' checkpoint exists yet. Run \`tasks checkpoint before ${task.ref}\` before making the change.`,
    )
  }

  // A `before` scoped with --scenario/--folder captured only those scenarios.
  // Running `after` over the whole suite would be reported as scenario-set
  // drift and abort, so inherit the original filters unless the caller set
  // their own.
  const recorded = latestRun(task.id, "before")?.selection ?? null
  const effective: CheckpointOptions =
    selectionOf(options) === null && recorded
      ? { ...options, scenarios: recorded.scenarios, folders: recorded.folders }
      : options

  // aio-vr writes results.json on `before` as well as `after`. If this run
  // aborts before producing its own, the previous file is still sitting there
  // and would be silently recorded as a comparison that never happened.
  const startedAt = Date.now()

  const { exitCode, output } = await spawnAioVr(
    buildArgs("after", name, effective),
    options.inheritStdio ?? false,
  )

  const resultsPath = join(checkpointDir(name), "results.json")
  const results = await readJson<ResultsFile>(resultsPath)

  const generatedAt = results?.generatedAt
    ? Date.parse(results.generatedAt)
    : NaN
  // Allow a second of slack for clock granularity between the two processes.
  const isFresh =
    Number.isFinite(generatedAt) && generatedAt >= startedAt - 1000

  if (!results?.results || !isFresh) {
    throw new Error(
      `aio-vr exited ${exitCode} without producing a comparison.` +
        (output ? `\n\n${output.trim()}` : "\nSee the output above."),
    )
  }

  const meta = await readJson<CheckpointMeta>(
    join(checkpointDir(name), "meta.json"),
  )

  const comparisons = results.results.map((result) => ({
    scenario: result.name,
    description: result.description ?? null,
    status: result.status as Comparison["status"],
    percentChanged: result.percentChanged ?? null,
    pixelDiffCount: result.pixelDiffCount ?? null,
    totalPixels: result.totalPixels ?? null,
    // In checkpoint mode aio-vr's "baseline" is the before image and its
    // "actual" is the after image.
    beforePath: result.baselinePath ?? beforeImagePath(name, result.name),
    afterPath: result.actualPath ?? null,
    diffPath: result.diffPath ?? null,
    browserLogStatus: result.browserLogStatus ?? null,
    browserLogChangeCount: result.browserLogChangeCount ?? null,
  }))

  const run: RecordRunInput = {
    taskId: task.id,
    checkpointName: name,
    phase: "after",
    exitCode,
    gitHead: meta?.gitHead ?? null,
    gitDirty: meta?.gitDirty ?? null,
    scenarioCount: comparisons.length,
    selection: selectionOf(effective),
    raw: results,
    comparisons,
  }

  return {
    runId: recordRun(run),
    phase: "after",
    checkpointName: name,
    exitCode,
    comparisons,
    output,
  }
}
