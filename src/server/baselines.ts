import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { workspace } from "../config/paths"
import { aioVrAvailable, spawnAioVr } from "./aiovr"
import type {
  BaselineReport,
  BaselineScenario,
  ComparisonStatus,
} from "../shared/types"

/**
 * The **baseline** side of aio-vr: how the app looks now against the last state
 * anyone approved.
 *
 * The task checkpoints this app already showed are scoped to one piece of work
 * and deleted when it closes. Baselines are the standing reference — drift
 * accumulates against them whether or not a task was open, which is exactly the
 * drift nobody notices until a release. Reading it needs no database: aio-vr
 * writes a results file and an approvals file, and those are the truth.
 *
 * Nothing here writes those files. `aio-vr run` and `aio-vr approve` do, and
 * this shells out to them so the CLI stays the only thing that decides what a
 * baseline is.
 */

/** aio-vr's own config, which is what decides where everything lives. */
interface AioVrConfig {
  baselinesDir?: string
  runsDir?: string
  resultsFile?: string
  approvalsFile?: string
}

interface ResultEntry {
  name: string
  description?: string
  status?: string
  percentChanged?: number
  pixelDiffCount?: number
  totalPixels?: number
  threshold?: number
  timestamp?: string
  durationMs?: number
  approved?: boolean
  scenarioPath?: string
  baselinePath?: string
  actualPath?: string
  diffPath?: string
  browserLogStatus?: string
  browserLogChangeCount?: number
  browserLogDiffPath?: string
}

interface ResultsFile {
  generatedAt?: string
  totals?: Record<string, number>
  results?: ResultEntry[]
}

interface ApprovalEntry {
  approvedAt?: string
  statusAtApproval?: string
}

interface ApprovalsFile {
  approvals?: Record<string, ApprovalEntry>
}

const CONFIG_NAME = "aio-vr.config.json"

/** Defaults matching aio-vr's own, for a workspace with no config file. */
const DEFAULTS = {
  resultsFile: "./runs/latest/results.json",
  approvalsFile: "./runs/approvals.json",
} as const

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

/** aio-vr's config paths are relative to its own directory. */
function inWorkspace(value: string): string {
  const { aioVrDir } = workspace()
  return isAbsolute(value) ? value : resolve(aioVrDir, value)
}

/** Everything is reported repo-root-relative, the same as checkpoint artefacts,
 *  because that is what `/api/image` accepts. */
function repoRelative(absolute: string): string {
  return relative(workspace().repoRoot, absolute)
}

async function readAioVrConfig(): Promise<AioVrConfig> {
  return (
    (await readJson<AioVrConfig>(join(workspace().aioVrDir, CONFIG_NAME))) ?? {}
  )
}

/**
 * A path as aio-vr reported it.
 *
 * The results file already writes repo-root-relative paths, so they pass
 * through. An absolute one is made relative, and a missing file becomes null
 * rather than a broken image: an actual or diff is genuinely absent for a
 * scenario that failed before it could render.
 */
function artifact(value: string | undefined): string | null {
  if (!value) return null
  const absolute = isAbsolute(value)
    ? value
    : resolve(workspace().repoRoot, value)
  return existsSync(absolute) ? repoRelative(absolute) : null
}

const STATUSES: ComparisonStatus[] = [
  "unchanged",
  "changed",
  "failed",
  "new-baseline",
]

function toStatus(value: string | undefined): ComparisonStatus {
  return STATUSES.includes(value as ComparisonStatus)
    ? (value as ComparisonStatus)
    : "failed"
}

/**
 * The last baseline run, joined with what has been approved since.
 *
 * `approved` is taken from the approvals file rather than from the run: the run
 * records what it found, and an approval that happened afterwards is newer than
 * the run that prompted it.
 */
export async function readBaselines(): Promise<BaselineReport> {
  const config = await readAioVrConfig()
  const resultsPath = inWorkspace(config.resultsFile ?? DEFAULTS.resultsFile)
  const approvalsPath = inWorkspace(
    config.approvalsFile ?? DEFAULTS.approvalsFile,
  )

  const results = await readJson<ResultsFile>(resultsPath)
  const approvals =
    (await readJson<ApprovalsFile>(approvalsPath))?.approvals ?? {}

  const scenarios: BaselineScenario[] = (results?.results ?? []).map(
    (entry) => {
      const approval = approvals[entry.name]
      return {
        scenario: entry.name,
        description: entry.description ?? null,
        status: toStatus(entry.status),
        percentChanged: entry.percentChanged ?? null,
        pixelDiffCount: entry.pixelDiffCount ?? null,
        totalPixels: entry.totalPixels ?? null,
        // The baseline is the reference, so it takes the "before" slot — which is
        // what lets one comparison card draw both kinds of comparison.
        beforePath: artifact(entry.baselinePath),
        afterPath: artifact(entry.actualPath),
        diffPath: artifact(entry.diffPath),
        browserLogStatus: entry.browserLogStatus ?? null,
        browserLogChangeCount: entry.browserLogChangeCount ?? null,
        scenarioPath: entry.scenarioPath ?? null,
        threshold: entry.threshold ?? null,
        timestamp: entry.timestamp ?? null,
        durationMs: entry.durationMs ?? null,
        approved: Boolean(approval) || Boolean(entry.approved),
        approvedAt: approval?.approvedAt ?? null,
        statusAtApproval: approval?.statusAtApproval ?? null,
        browserLogDiffPath: artifact(entry.browserLogDiffPath),
      }
    },
  )

  return {
    hasRun: !!results,
    generatedAt: results?.generatedAt ?? null,
    totals: results?.totals ?? {},
    scenarios,
    resultsPath: repoRelative(resultsPath),
    available: aioVrAvailable(),
  }
}

function requireAioVr(): void {
  if (aioVrAvailable()) return
  throw new Error(
    "Could not find the 'aio-vr' executable on PATH. Install aio-visual-regression, or set AIO_VR_BIN.",
  )
}

/**
 * Re-run scenarios against their baselines.
 *
 * A run drives a real browser, so it is slow — the whole suite comfortably
 * outlives an ordinary request, which is why the server's idle timeout is
 * already raised for checkpoint captures. Filtering to the scenario being looked
 * at is the fast path, and the usual one: you fix a drift and re-check that one.
 *
 * A non-zero exit is not an error here. `aio-vr run` exits non-zero whenever
 * anything is `changed` or `failed`, which is the normal state of a page whose
 * whole job is to report drift — so the report is what gets returned, and the
 * output only travels with it for the failures worth reading.
 */
export async function runBaselines(scenarios: string[] = []): Promise<{
  report: BaselineReport
  exitCode: number
  output: string
}> {
  requireAioVr()

  const args = ["run"]
  for (const scenario of scenarios) args.push("--scenario", scenario)

  const { exitCode, output } = await spawnAioVr(args, false)
  return { report: await readBaselines(), exitCode, output }
}

/**
 * Promote a scenario's latest capture to be its baseline — "this change is
 * intended".
 *
 * Deliberately one scenario at a time. Approving is the one irreversible thing
 * on the page: it overwrites the reference the next run compares against, so
 * there is no "approve all" here to fire off across a suite nobody has looked
 * through.
 */
export async function approveBaseline(
  scenario: string,
): Promise<BaselineReport> {
  requireAioVr()
  if (!scenario.trim()) throw new Error("A scenario name is required.")

  const { exitCode, output } = await spawnAioVr(["approve", scenario], false)
  if (exitCode !== 0) {
    throw new Error(
      `aio-vr approve ${scenario} failed.${output.trim() ? `\n\n${output.trim()}` : ""}`,
    )
  }
  return readBaselines()
}
