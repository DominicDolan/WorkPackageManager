import { existsSync } from "node:fs"
import { join } from "node:path"
import { packageRoot } from "../config/paths"
import { resolveArtifact, workspace } from "../config/paths"
import {
  aioVrAvailable,
  captureAfter,
  captureBefore,
  cleanCheckpoint,
} from "./aiovr"
import {
  addTaskAttachment,
  removeTaskAttachment,
  resolveTaskAsset,
} from "./attachments"
import { captureBeforeRetro, resolveRetroTarget } from "./retro"
import {
  addDependency,
  addNote,
  createWorkPackage,
  createInvestigatedWorkPackage,
  createInvestigation,
  createTask,
  deleteWorkPackage,
  deleteInvestigation,
  deleteTask,
  deleteCombinedBranch,
  findTask,
  getInvestigationDetail,
  getTaskDetail,
  isInvestigationStatus,
  isModelTier,
  isPriority,
  isStatus,
  ensureWorkPackageInvestigation,
  listCombinedBranches,
  listWorkPackages,
  listInvestigations,
  listTasks,
  moveTask,
  recordCombine,
  removeDependency,
  renameCombinedBranch,
  listWorkPackageRuns,
  reorderWorkPackages,
  reorderTasks,
  requireCombinedBranch,
  requireWorkPackage,
  requireTask,
  recordCombinedBranch,
  setInvestigationStatus,
  setWorkPackage,
  updateCombinedBranch,
  updateWorkPackage,
  updateInvestigation,
  updateTask,
  updateTaskBranchName,
  setStatus,
} from "./repo"
import { issueFacets, listIssues, readIssue } from "./issues"
import {
  reconcileWorkPackageRuns,
  startWorkPackageRun,
  stopWorkPackageRun,
} from "./workPackageRuns"
import {
  agentEnvironment,
  getRun,
  harnessModels,
  listRuns,
  reconcileRuns,
  startRun,
  resumeRun,
  stopRun,
} from "./agents"
import {
  announceChange,
  currentRevisions,
  ensureWatchers,
  onChange,
} from "./watch"
import {
  addAttachment,
  createNote,
  deleteNote,
  initNotes,
  listFolders,
  listNotes,
  listTags,
  indexImageFolders,
  notesWorkspaceInfo,
  pullNotes,
  readNote,
  removeAttachment,
  resolveNoteAsset,
  resolveNoteLink,
  syncNotes,
  updateNote,
} from "./notes"
import {
  attachNote,
  detachDeletedNote,
  detachNote,
  renameNoteLinks,
} from "./noteLinks"
import {
  branchExists,
  builtOnTopOf,
  createPullRequest,
  currentBranch,
  defaultBaseBranch,
  generatePrDescription,
  listLocalBranches,
  readBranch,
  refreshBaseBranch,
  toolAvailability,
  type BaseRefresh,
} from "./branches"
import {
  checksBlockingPr,
  checksProgress,
  configuredChecks,
  startChecks,
} from "./checks"
import {
  AGENT_COMMANDS,
  AGENT_PERMISSION_MODES,
  AGENT_RUN_MODES,
  INVESTIGATION_STATUSES,
  STATUS_LABELS,
  parseEstimateUnits,
  PRIORITIES,
  STATUSES,
  type AgentCommand,
  type AgentPermissionMode,
  type AgentRunMode,
  type CombinedBranchDetail,
  type WorkPackageAdvanceOutcome,
  type InvestigationStatus,
  type Status,
  type Task,
} from "../shared/types"
import { validateBranchName } from "./repo"
import {
  getWorkPackageDetail,
  workPackageBranchOf,
  mergeTaskIntoWorkPackageBranch,
} from "./workPackageBranch"
import { approveBaseline, readBaselines, runBaselines } from "./baselines"

const ws = workspace()
const port = Number(process.env.TASKS_API_PORT ?? ws.config.apiPort)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function fail(message: string, status = 400): Response {
  return json({ error: message }, status)
}

/** Turn a thrown error into the response the UI expects. The `require*` lookups
 *  are the only routines that throw a "not found", so those map to 404. */
function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  const missing =
    /^No (task|investigation) with ref/.test(message) ||
    /^No work package with ref or name/.test(message) ||
    /^No agent run with id/.test(message) ||
    /^No (note|issue) at /.test(message)
  return fail(message, missing ? 404 : 400)
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new Error("Request body must be valid JSON.")
  }
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value))
    throw new Error("tags must be an array of strings.")
  return value.map((tag) => String(tag).trim()).filter(Boolean)
}

/** A plan estimate from a request body, absent staying absent so a PATCH that
 *  does not mention it leaves the stored one alone. */
function parseUnits(value: unknown): number | undefined {
  return value === undefined ? undefined : parseEstimateUnits(value)
}

/** A list of task refs from a request body. Absent stays absent — an empty
 *  array is a deliberate "no dependencies" and must not be confused with it. */
function parseRefs(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string")) {
    throw new Error(`${field} must be an array of task references.`)
  }
  return (value as string[]).map((ref) => ref.trim()).filter(Boolean)
}

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: ws.repoRoot })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/**
 * Merge a task into its work package's branch, flattened to "what went wrong, if
 * anything". A task in no work package is not a problem — there is simply nothing to
 * merge into — so that reads as success.
 */
function mergeIntoWorkPackageBranch(ref: string): string | null {
  try {
    const result = mergeTaskIntoWorkPackageBranch(ref)
    if (!result.workPackage || result.merged) return null
    return (
      `${ref}'s commits do not replay onto '${result.branch}' — they collide with work already there. ` +
      `Nothing was changed: the rebase was aborted and both branches are as they were. Resolve it by ` +
      `hand ('git rebase ${result.branch} ${result.taskBranch}', fix, 'git rebase --continue'), then ` +
      `merge ${ref} again to register it.\n${result.conflict}`
    )
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function cherryPickInProgress(): boolean {
  // Use Git rather than assuming `.git` is a directory: linked worktrees store
  // their state in Git's real directory.
  return (
    git(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]).code === 0
  )
}

/**
 * Take a whole work package to Verified, or all the way to Closed.
 *
 * Work packages are worked as one piece and they finish as one piece, so signing each
 * member off by hand is busywork the moment a work package has more than a couple of
 * tasks. Closing implies verifying: a task sitting at Dev Complete is walked
 * through Verified on its way out, which is exactly what doing it by hand would
 * have done.
 *
 * Nothing here is all-or-nothing. A task still being written is left alone, and
 * one that fails — a checkpoint clean that errors, say — does not stop the rest.
 * Every task comes back with what happened to it, because "some of them moved"
 * is the honest answer and the caller has to be able to show it.
 */
async function advanceWorkPackage(
  refOrName: string,
  target: "verified" | "closed",
): Promise<{
  workPackage: ReturnType<typeof getWorkPackageDetail>
  outcomes: WorkPackageAdvanceOutcome[]
}> {
  const workPackage = getWorkPackageDetail(refOrName)
  const outcomes: WorkPackageAdvanceOutcome[] = []

  for (const task of workPackage.tasks) {
    const from = task.status
    const outcome: WorkPackageAdvanceOutcome = {
      ref: task.ref,
      title: task.title,
      from,
      to: null,
    }

    if (from === "closed" || from === target) {
      outcome.skipped = `Already ${STATUS_LABELS[from]}.`
    } else if (from === "backlog" || from === "in_progress") {
      outcome.skipped = `Still ${STATUS_LABELS[from]} — only Dev Complete work can be signed off.`
    } else {
      try {
        if (from === "dev_complete") {
          setStatus(
            task.ref,
            "verified",
            `Verified with ${workPackage.ref} (${workPackage.name}).`,
          )
        }
        if (target === "closed") await closeTask(task.ref)
        outcome.to = target
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error)
        // Say where it actually ended up: a close that failed after the verify
        // landed leaves the task verified, not where it started.
        outcome.to = findTask(task.ref)?.status ?? null
        if (outcome.to === from) outcome.to = null
      }
    }

    outcomes.push(outcome)
  }

  return { workPackage: getWorkPackageDetail(workPackage.ref), outcomes }
}

/** Build one linear branch by cherry-picking each selected task branch, in the
 * order chosen. This produces ordinary commits on one branch, precisely the
 * form a cherry-pick-based PR copy can move to another repository. */
async function closeTask(
  ref: string,
): Promise<ReturnType<typeof getTaskDetail>> {
  const task = requireTask(ref)
  if (task.status !== "verified")
    throw new Error(`${task.ref} must be Verified before it can be closed.`)
  await cleanCheckpoint(task)
  setStatus(task.ref, "closed", "Visual checkpoint cleaned and task closed.")
  return getTaskDetail(task.ref)
}

async function finishCombine(
  branchName: string,
  taskRefs: string[],
  closeTasks: boolean,
): Promise<ReturnType<typeof getTaskDetail>[]> {
  const tasks = taskRefs.map((ref) => getTaskDetail(ref))
  for (const task of tasks)
    recordCombinedBranch(task.ref, branchName, taskRefs.length > 1)
  const branch = requireCombinedBranch(branchName)
  recordCombine({
    branchName,
    baseBranch: branch.baseBranch,
    taskRefs,
    combineCloseTasks: closeTasks,
  })
  if (closeTasks) for (const task of tasks) await closeTask(task.ref)
  return tasks.map((task) => getTaskDetail(task.ref))
}

interface CombineResult {
  branchName: string
  tasks: ReturnType<typeof getTaskDetail>[]
  conflicted: boolean
  /** What the branch was cut from, and what had to happen to get it current. */
  base: { branch: string } & BaseRefresh
}

async function combineTasks(
  refs: string[],
  requestedBranch: string,
  closeTasks: boolean,
): Promise<CombineResult> {
  const branchName = validateBranchName(requestedBranch)
  const uniqueRefs = [...new Set(refs)]
  if (uniqueRefs.length < 1) throw new Error("Select at least one task.")
  // One task takes the identical path — cut a branch, cherry-pick its commits
  // onto it — it is just called "preparing" rather than "combining", so the
  // messages a single selection can hit are worded for that.
  const single = uniqueRefs.length === 1
  const verb = single ? "prepared" : "combined"
  let tasks = uniqueRefs.map((ref) => getTaskDetail(ref))
  for (const task of tasks) {
    if (!task.branchName) throw new Error(`${task.ref} has no assigned branch.`)
    if (!branchExists(task.branchName)) {
      // Older generated names were truncated. If Git has exactly one branch for
      // this task ref, repair that stale database assignment automatically.
      const needle = `/${task.ref.toLowerCase()}-`
      const candidates = git([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ])
        .stdout.trim()
        .split("\n")
        .filter((name) => name.toLowerCase().includes(needle))
      if (candidates.length === 1) {
        updateTaskBranchName(task.ref, candidates[0]!)
      } else {
        throw new Error(
          `${task.ref}'s assigned branch '${task.branchName}' does not exist locally. Update the task's branch assignment to the renamed Git branch first.`,
        )
      }
    }
    if (task.status !== "dev_complete" && task.status !== "verified") {
      throw new Error(
        `${task.ref} must be Dev Complete or Verified before it can be ${verb}.`,
      )
    }
    if (closeTasks && task.status !== "verified") {
      throw new Error(
        `${task.ref} must be Verified when "Close tasks" is selected.`,
      )
    }
  }

  const current = git(["branch", "--show-current"]).stdout.trim()
  // The delivery branch is always cut from the base branch, never from whatever
  // happens to be checked out — a PR's diff is against its base, so anything
  // else puts unrelated commits in it (or, when the checked-out branch is one of
  // the selected task branches, leaves that task with an empty range).
  const baseBranch = defaultBaseBranch()
  if (cherryPickInProgress()) {
    throw new Error(
      `A cherry-pick is already paused on '${current || "HEAD"}'. Resolve and stage its conflicts, then use the delivery branch's Continue button (or run 'git cherry-pick --abort' to cancel it) before starting another one.`,
    )
  }
  if (git(["status", "--porcelain"]).stdout.trim())
    throw new Error(
      "Working tree must be clean before building a delivery branch.",
    )
  if (
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
      .code === 0
  ) {
    throw new Error(`Branch '${branchName}' already exists.`)
  }

  // Catch the base up with origin first, so the work is picked onto current
  // master rather than onto whatever it was the last time anyone pulled.
  const baseRefresh = refreshBaseBranch(baseBranch)

  // The branch name can have been corrected after the task detail was loaded.
  tasks = uniqueRefs.map((ref) => getTaskDetail(ref))

  // A grouped task's branch is cut from its work package's branch, so everything the
  // work package has merged so far sits between the base and this task's commits —
  // cherry-picking `base..taskBranch` would deliver the work package's other tasks
  // under this branch's name. The work package branch is already the delivery vehicle
  // for that work, so this points at it rather than guessing a range.
  for (const task of tasks) {
    const owned = workPackageBranchOf(task)
    if (!owned || !branchExists(owned.branch)) continue
    if (!builtOnTopOf(baseBranch, owned.branch, task.branchName!)) continue
    throw new Error(
      `${task.ref} is in ${owned.workPackage.ref} (${owned.workPackage.name}), and its branch is built on that work package's ` +
        `branch '${owned.branch}' — combining it here would carry the work package's other tasks with it. ` +
        `Deliver the work package from '${owned.branch}' instead.`,
    )
  }
  // Every range is resolved before the branch is created, so a task with nothing
  // to pick fails without leaving a stray branch behind.
  const commitsToPick: string[] = []
  for (const task of tasks) {
    const forkPoint = git(["merge-base", baseBranch, task.branchName!])
    if (forkPoint.code !== 0 || !forkPoint.stdout.trim())
      throw new Error(
        `Could not find a common ancestor between '${baseBranch}' and ${task.ref} (${task.branchName}).`,
      )
    const commits = git([
      "rev-list",
      "--reverse",
      `${forkPoint.stdout.trim()}..${task.branchName}`,
    ])
    if (commits.code !== 0)
      throw new Error(
        commits.stderr.trim() ||
          `Could not read the commits on ${task.ref} (${task.branchName}).`,
      )
    if (!commits.stdout.trim())
      throw new Error(
        `${task.ref} (${task.branchName}) has no commits that '${baseBranch}' does not already have.`,
      )
    commitsToPick.push(...commits.stdout.trim().split("\n"))
  }

  const create = git(["switch", "-c", branchName, baseBranch])
  if (create.code !== 0)
    throw new Error(
      create.stderr.trim() ||
        `Could not create '${branchName}' from '${baseBranch}'.`,
    )
  for (let index = 0; index < commitsToPick.length; index++) {
    if (git(["cherry-pick", commitsToPick[index]!]).code !== 0) {
      recordCombine({
        branchName,
        baseBranch,
        taskRefs: tasks.map((task) => task.ref),
        combineState: "conflict",
        combinePendingCommits: commitsToPick.slice(index + 1),
        combineCloseTasks: closeTasks,
      })
      return {
        branchName,
        tasks,
        conflicted: true,
        base: { branch: baseBranch, ...baseRefresh },
      }
    }
  }
  // `finishCombine` marks the selected tasks and needs the durable delivery
  // branch record. Record it before finishing so a conflict-free combine does
  // not try to look up a branch that has not been saved yet.
  recordCombine({
    branchName,
    baseBranch,
    taskRefs: tasks.map((task) => task.ref),
    combineCloseTasks: closeTasks,
  })
  return {
    branchName,
    tasks: await finishCombine(
      branchName,
      tasks.map((task) => task.ref),
      closeTasks,
    ),
    conflicted: false,
    base: { branch: baseBranch, ...baseRefresh },
  }
}

async function continueCombine(
  branchName: string,
): Promise<{ branchName: string; tasks: ReturnType<typeof getTaskDetail>[] }> {
  const branch = requireCombinedBranch(branchName)
  if (branch.combineState !== "conflict")
    throw new Error(`'${branchName}' is not waiting for a conflict resolution.`)
  if (git(["branch", "--show-current"]).stdout.trim() !== branchName)
    throw new Error(
      `Switch to '${branchName}' before continuing the cherry-pick.`,
    )
  // The user may have already run `git cherry-pick --continue` while resolving
  // the conflict. In that case Git has removed CHERRY_PICK_HEAD, but the saved
  // delivery-branch state still says conflict. Treat the button as “finish the
  // combine”: only ask Git to continue when a pick is actually paused.
  if (cherryPickInProgress()) {
    const continued = git(["cherry-pick", "--continue"])
    if (continued.code !== 0)
      throw new Error(
        continued.stderr.trim() ||
          "Resolve all conflicts and stage the files before continuing.",
      )
  }
  for (let index = 0; index < branch.combinePendingCommits.length; index++) {
    if (git(["cherry-pick", branch.combinePendingCommits[index]!]).code !== 0) {
      recordCombine({
        branchName,
        baseBranch: branch.baseBranch,
        taskRefs: branch.taskRefs,
        combineState: "conflict",
        combinePendingCommits: branch.combinePendingCommits.slice(index + 1),
        combineCloseTasks: branch.combineCloseTasks,
      })
      return {
        branchName,
        tasks: branch.taskRefs.map((ref) => getTaskDetail(ref)),
      }
    }
  }
  return {
    branchName,
    tasks: await finishCombine(
      branchName,
      branch.taskRefs,
      branch.combineCloseTasks,
    ),
  }
}

/* -------------------------------------------------------------- branches */

/** A stored branch plus its live Git state and the tasks it carries. Tasks are
 *  looked up leniently — a combined branch outlives the tasks it was built from,
 *  and a deleted one should not break the view. */
function branchDetail(branchName: string): CombinedBranchDetail {
  const branch = requireCombinedBranch(branchName)
  const base = branch.baseBranch ?? defaultBaseBranch()
  const tasks = branch.taskRefs
    .map((ref) => findTask(ref))
    .filter((task): task is Task => task !== null)

  return {
    ...branch,
    git: readBranch(branch.branchName, base),
    tasks,
    checksRunning: checksProgress(branch.branchName),
  }
}

async function handleBranches(
  request: Request,
  rest: string[],
): Promise<Response> {
  // Branch names contain slashes, so the name arrives percent-encoded as one
  // segment and everything after it is the action.
  const [rawName, action] = rest

  if (!rawName) {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    return json({
      branches: listCombinedBranches().map((branch) =>
        branchDetail(branch.branchName),
      ),
      currentBranch: currentBranch(),
      localBranches: listLocalBranches(),
      defaultBase: defaultBaseBranch(),
    })
  }

  const name = decodeURIComponent(rawName)

  if (!action) {
    if (request.method === "GET") return json({ branch: branchDetail(name) })

    if (request.method === "PATCH") {
      const input = await body<{
        branchName?: string
        baseBranch?: string
        remoteBranch?: string
        prTitle?: string
        prBody?: string
      }>(request)
      let savedName = name
      if (input.branchName !== undefined) {
        const next = validateBranchName(input.branchName)
        if (next !== name) {
          if (branchExists(next))
            return fail(`Branch '${next}' already exists locally.`)
          const renamed = git(["branch", "-m", name, next])
          if (renamed.code !== 0)
            return fail(renamed.stderr.trim() || `Could not rename '${name}'.`)
          renameCombinedBranch(name, next)
          savedName = next
        }
      }

      if (input.baseBranch !== undefined) {
        const base = validateBranchName(input.baseBranch)
        if (!branchExists(base))
          return fail(
            `PR target branch '${base}' does not exist locally. Use an existing branch such as 'master'.`,
          )
      }
      if (input.remoteBranch !== undefined && input.remoteBranch.trim()) {
        validateBranchName(input.remoteBranch)
      }
      updateCombinedBranch(savedName, {
        baseBranch:
          input.baseBranch === undefined
            ? undefined
            : validateBranchName(input.baseBranch),
        remoteBranch:
          input.remoteBranch === undefined
            ? undefined
            : input.remoteBranch.trim()
              ? validateBranchName(input.remoteBranch)
              : null,
        prTitle: input.prTitle,
        prBody: input.prBody,
      })
      return json({ branch: branchDetail(savedName) })
    }

    // Forgets the branch here only; the Git branch and any PR are left alone.
    if (request.method === "DELETE") {
      deleteCombinedBranch(name)
      return json({ deleted: name })
    }

    return fail("Method not allowed.", 405)
  }

  if (request.method !== "POST") return fail("Method not allowed.", 405)

  // /api/branches/:name/describe — hands the commit history to `pi`.
  if (action === "describe") {
    const branch = requireCombinedBranch(name)
    const base = branch.baseBranch ?? defaultBaseBranch()
    const { title, body: prBody } = generatePrDescription(
      branch.branchName,
      base,
    )

    // Persisted immediately: a generation takes real time and money, and losing
    // it to a closed tab would be the worst possible failure here.
    updateCombinedBranch(name, { prTitle: title, prBody, baseBranch: base })
    return json({ branch: branchDetail(name) })
  }

  // /api/branches/:name/checks — runs the repo's configured pre-PR commands.
  if (action === "checks") {
    const branch = requireCombinedBranch(name)
    if (!configuredChecks().length) {
      return fail(
        'No checks are configured — add "checks" to .tasks/tasks.config.json.',
      )
    }
    const input = await body<{ check?: unknown }>(request).catch(
      () => ({}) as { check?: unknown },
    )
    if (
      input.check !== undefined &&
      (typeof input.check !== "string" ||
        !configuredChecks().some((check) => check.name === input.check))
    ) {
      return fail("Unknown check.", 400)
    }
    const base = branch.baseBranch ?? defaultBaseBranch()
    // Started, not awaited: a suite outlives any request worth holding open, so
    // this returns immediately and the page follows `checksRunning`.
    startChecks({
      branch: branch.branchName,
      base,
      check: input.check as string | undefined,
      previous: branch.checks,
    })
    return json({ branch: branchDetail(name) })
  }

  // /api/branches/:name/pr — pushes if needed, then opens the PR with `gh`.
  if (action === "pr") {
    const input = await body<{ draft?: boolean; force?: boolean }>(
      request,
    ).catch(() => ({}) as { draft?: boolean; force?: boolean })
    const branch = requireCombinedBranch(name)

    // The gate. `force` is deliberately available: a check can be broken on
    // master, or irrelevant to a docs-only branch, and a tool that cannot be
    // overridden gets worked around instead of used.
    const blocked = input.force
      ? null
      : checksBlockingPr(branch.checks, branch.branchName)
    if (blocked)
      throw new Error(
        `${blocked} Run the checks, or open the pull request anyway.`,
      )

    if (branch.prUrl)
      throw new Error(`A pull request was already opened: ${branch.prUrl}`)
    const base = branch.baseBranch ?? defaultBaseBranch()
    if (!branchExists(base))
      throw new Error(
        `PR target branch '${base}' does not exist locally. Update branch settings and choose an existing target such as 'master'.`,
      )
    if (!branch.prTitle?.trim()) {
      throw new Error(
        "Generate or write a description before opening the pull request.",
      )
    }

    const result = await createPullRequest({
      branch: branch.branchName,
      base,
      title: branch.prTitle,
      body: branch.prBody ?? "",
      draft: input.draft ?? false,
      remoteBranch: branch.remoteBranch,
    })

    updateCombinedBranch(name, { prUrl: result.url, prNumber: result.number })
    for (const ref of branch.taskRefs) {
      if (findTask(ref)) addNote(ref, `Pull request opened: ${result.url}`)
    }
    return json({ branch: branchDetail(name), pushed: result.pushed })
  }

  return fail("Unknown endpoint.", 404)
}

/* -------------------------------------------------------- investigations */

async function handleInvestigations(
  request: Request,
  url: URL,
  rest: string[],
): Promise<Response> {
  const [ref, action] = rest

  // /api/investigations
  if (!ref) {
    if (request.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined
      if (status && !isInvestigationStatus(status)) {
        return fail(`Unknown investigation status '${status}'.`)
      }
      return json({
        investigations: listInvestigations({
          status: status as InvestigationStatus | undefined,
        }),
      })
    }

    if (request.method === "POST") {
      const input = await body<{ title?: string; brief?: string }>(request)
      if (!input.title) return fail("An investigation needs a title.")
      return json(
        {
          investigation: getInvestigationDetail(
            createInvestigation(input as { title: string; brief?: string }).ref,
          ),
        },
        201,
      )
    }

    return fail("Method not allowed.", 405)
  }

  // /api/investigations/:ref
  if (!action) {
    if (request.method === "GET")
      return json({ investigation: getInvestigationDetail(ref) })

    if (request.method === "PATCH") {
      const input = await body<{
        title?: string
        brief?: string
        findings?: string
      }>(request)
      updateInvestigation(ref, input)
      return json({ investigation: getInvestigationDetail(ref) })
    }

    if (request.method === "DELETE") {
      deleteInvestigation(ref)
      return json({ deleted: ref })
    }

    return fail("Method not allowed.", 405)
  }

  // /api/investigations/:ref/status
  if (action === "status") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ status?: string }>(request)
    if (!input.status || !isInvestigationStatus(input.status)) {
      return fail(
        `status must be one of: ${INVESTIGATION_STATUSES.join(", ")}.`,
      )
    }
    setInvestigationStatus(ref, input.status)
    return json({ investigation: getInvestigationDetail(ref) })
  }

  return fail("Unknown endpoint.", 404)
}

/* ----------------------------------------------------------------- notes */

/**
 * Notes are files, so these routes are thin: read the folder, write the folder,
 * and let `notes.ts` do the resolving. A note's path is its identity and it
 * contains slashes, so — like a branch name — it travels as one percent-encoded
 * segment with the action after it.
 */
async function handleNotes(
  request: Request,
  url: URL,
  rest: string[],
): Promise<Response> {
  const [rawPath, action, attachmentName] = rest

  // /api/notes/asset — an image or file streamed out of the notes folder. Named
  // rather than pathed, so it cannot collide with a note (those all end `.md`).
  if (rawPath === "asset") {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    // Either a root-relative path, or a link exactly as it is written inside a
    // note — the preview passes the latter and lets the server resolve it.
    const note = url.searchParams.get("note")
    const href = url.searchParams.get("href")
    const direct = url.searchParams.get("path")
    const path = note && href ? resolveNoteLink(note, href) : direct
    if (!path) return fail("An asset path is required.")

    const absolute = resolveNoteAsset(path)
    if (!absolute) return fail("No such file inside the notes folder.", 404)
    // Attachments are immutable once written — a re-upload gets a new name — so
    // unlike the checkpoint artefacts these are safe to cache.
    return new Response(Bun.file(absolute), {
      headers: { "cache-control": "private, max-age=300" },
    })
  }

  if (rawPath === "init") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    return json({ init: initNotes(), workspace: notesWorkspaceInfo() })
  }

  // Both the Notes view and Issues are backed by this folder, so both offer it.
  if (rawPath === "pull") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    return json({ ...pullNotes(), workspace: notesWorkspaceInfo() })
  }

  if (rawPath === "sync") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ push?: boolean; message?: string }>(
      request,
    ).catch(() => ({}) as { push?: boolean; message?: string })
    return json(
      syncNotes({ push: input.push ?? false, message: input.message }),
    )
  }

  // /api/notes
  if (!rawPath) {
    if (request.method === "GET") {
      // Folders of loose images get a note before the list is read, so images
      // added to the folder by hand show up on the next refresh rather than
      // needing a command run. It only ever creates, and only where there is no
      // note to overwrite.
      indexImageFolders()
      return json({
        notes: listNotes({
          tag: url.searchParams.get("tag") ?? undefined,
          folder: url.searchParams.get("folder") ?? undefined,
          search: url.searchParams.get("q") ?? undefined,
        }),
        folders: listFolders(),
        tags: listTags(),
        workspace: notesWorkspaceInfo(),
      })
    }

    if (request.method === "POST") {
      const input = await body<{
        title?: string
        folder?: string
        path?: string
        body?: string
        tags?: unknown
      }>(request)
      if (!input.title?.trim()) return fail("A note needs a title.")
      return json(
        {
          note: createNote({
            title: input.title,
            folder: input.folder,
            path: input.path,
            body: input.body,
            tags: parseTags(input.tags),
          }),
        },
        201,
      )
    }

    return fail("Method not allowed.", 405)
  }

  const path = decodeURIComponent(rawPath)

  // /api/notes/:path
  if (!action) {
    if (request.method === "GET") return json({ note: readNote(path) })

    if (request.method === "PATCH") {
      const input = await body<{
        title?: string
        body?: string
        tags?: unknown
        path?: string
      }>(request)
      const note = updateNote(path, {
        title: input.title,
        body: input.body,
        tags: parseTags(input.tags),
        path: input.path,
      })
      renameNoteLinks(path, note.path)
      return json({ note })
    }

    if (request.method === "DELETE") {
      const deleted = deleteNote(path)
      detachDeletedNote(deleted)
      return json({ deleted })
    }

    return fail("Method not allowed.", 405)
  }

  // /api/notes/:path/attachments — a paste, a drop, or a file picker.
  if (action === "attachments") {
    if (attachmentName !== undefined) {
      if (request.method !== "DELETE") return fail("Method not allowed.", 405)
      removeAttachment(path, decodeURIComponent(attachmentName))
      return json({ note: readNote(path) })
    }

    if (request.method !== "POST") return fail("Method not allowed.", 405)

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return fail("Attachments must be uploaded as multipart/form-data.")
    }

    const uploaded = form
      .getAll("file")
      .filter((entry): entry is File => entry instanceof File)
    if (!uploaded.length) return fail("No file was uploaded.")

    const added = []
    for (const file of uploaded) {
      added.push(
        addAttachment(
          path,
          file.name || "attachment",
          await file.arrayBuffer(),
        ),
      )
    }
    return json({ added, note: readNote(path) }, 201)
  }

  return fail("Unknown endpoint.", 404)
}

/* ---------------------------------------------------------------- issues */

/**
 * Read-only, and re-read per request. The files are fetched by something else
 * and can be replaced at any moment, so there is nothing to cache and nothing
 * here that writes.
 */
function handleIssues(request: Request, url: URL, rest: string[]): Response {
  if (request.method !== "GET") return fail("Method not allowed.", 405)

  const [rawId] = rest

  if (!rawId) {
    const state = url.searchParams.get("state") ?? undefined
    if (state && state !== "open" && state !== "closed" && state !== "all") {
      return fail("state must be 'open', 'closed' or 'all'.")
    }

    return json({
      issues: listIssues({
        state: state as "open" | "closed" | "all" | undefined,
        source: url.searchParams.get("source") ?? undefined,
        label: url.searchParams.get("label") ?? undefined,
        search: url.searchParams.get("q") ?? undefined,
      }),
      facets: issueFacets(),
      notes: notesWorkspaceInfo(),
    })
  }

  return json({ issue: readIssue(decodeURIComponent(rawId)) })
}

/* ---------------------------------------------------------------- events */

/** Heartbeat interval. Comfortably inside the server's idle timeout, so a quiet
 *  workspace does not have its stream reaped as dead. */
const SSE_HEARTBEAT_MS = 25_000

/**
 * `GET /api/events` — an SSE stream saying which store just changed.
 *
 * Deliberately carries no data beyond the channel and a revision number. The
 * client already knows how to load every view it can show; what it lacked was
 * any way to know it should. Sending the payload here would mean a second,
 * parallel definition of what each view needs, and one of the two would rot.
 */
function handleEvents(request: Request): Response {
  if (request.method !== "GET") return fail("Method not allowed.", 405)

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          // The client vanished between the event and this write; the abort
          // handler below is what actually tears the stream down.
        }
      }

      // The opening frame carries where each channel stands, so a client that
      // reconnected after a dropped connection can see what it slept through.
      send(
        `event: hello\ndata: ${JSON.stringify({ revisions: currentRevisions() })}\n\n`,
      )

      unsubscribe = onChange((event) => {
        send(`event: change\ndata: ${JSON.stringify(event)}\n\n`)
      })

      heartbeat = setInterval(() => send(": ping\n\n"), SSE_HEARTBEAT_MS)

      const close = (): void => {
        unsubscribe?.()
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // Already closed by the runtime.
        }
      }

      request.signal.addEventListener("abort", close)
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Nothing here is proxied by default, but a stream that a proxy decides to
      // buffer is a stream that never arrives.
      "x-accel-buffering": "no",
    },
  })
}

/* ---------------------------------------------------------------- agents */

/**
 * Launching an agent, and watching one that was launched.
 *
 * The client sends the *intent* — which command, against what, with what extra
 * prompt — and never the argv. Building the command line here is what keeps a
 * browser from being able to ask this server to run anything it likes.
 */
async function handleAgents(
  request: Request,
  url: URL,
  rest: string[],
): Promise<Response> {
  const [head, id, action] = rest

  // /api/agents — which harnesses exist, and whether a window can be opened.
  if (!head) {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    return json(agentEnvironment())
  }

  // /api/agents/models?harness=pi — fetched separately when a harness's list is
  // large or slow (currently pi's catalogue).
  if (head === "models") {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    const which = url.searchParams.get("harness")
    if (!which) return fail("A harness is required.")
    return json({ models: harnessModels(which) })
  }

  // /api/agents/run
  if (head === "run") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{
      harness?: string
      model?: string
      mode?: string
      command?: string
      target?: string
      extra?: string
      subjectKind?: string
      subjectRef?: string
      permissionMode?: string
    }>(request)

    if (!input.harness) return fail("A harness is required.")
    if (
      !input.command ||
      !AGENT_COMMANDS.includes(input.command as AgentCommand)
    ) {
      return fail(`command must be one of: ${AGENT_COMMANDS.join(", ")}.`)
    }
    if (!input.mode || !AGENT_RUN_MODES.includes(input.mode as AgentRunMode)) {
      return fail(`mode must be one of: ${AGENT_RUN_MODES.join(", ")}.`)
    }
    if (
      input.permissionMode !== undefined &&
      !AGENT_PERMISSION_MODES.includes(
        input.permissionMode as AgentPermissionMode,
      )
    ) {
      return fail(
        `permissionMode must be one of: ${AGENT_PERMISSION_MODES.join(", ")}.`,
      )
    }

    return json(
      {
        run: startRun({
          harness: input.harness,
          model: input.model ?? "",
          mode: input.mode as AgentRunMode,
          command: input.command as AgentCommand,
          target: input.target ?? "",
          extra: input.extra ?? "",
          subjectKind: input.subjectKind ?? "other",
          subjectRef: input.subjectRef ?? "",
          // A headless run has nobody to answer a prompt, so it defaults to the
          // only mode that never asks; an interactive one keeps the harness default.
          permissionMode:
            (input.permissionMode as AgentPermissionMode | undefined) ??
            (input.mode === "print" ? "bypassPermissions" : "manual"),
        }),
      },
      201,
    )
  }

  if (head !== "runs") return fail("Unknown endpoint.", 404)

  // /api/agents/runs
  if (!id) {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    return json({
      runs: listRuns({
        subjectKind: url.searchParams.get("kind") ?? undefined,
        subjectRef: url.searchParams.get("ref") ?? undefined,
      }),
    })
  }

  const runId = Number(id)
  if (!Number.isInteger(runId)) return fail("A run id must be a number.")

  // /api/agents/runs/:id — the run plus the tail of its log.
  if (!action) {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    return json({ run: await getRun(runId) })
  }

  if (action === "stop") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    return json({ run: stopRun(runId) })
  }

  // /api/agents/runs/:id/resume — reopen this run's conversation in a terminal.
  if (action === "resume") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    return json({ run: resumeRun(runId) })
  }

  return fail("Unknown endpoint.", 404)
}

/* ----------------------------------------------------------------- routes */

/* ---------------------------------------------------------------- work packages */

async function handleWorkPackages(
  request: Request,
  rest: string[],
): Promise<Response> {
  const [ref, action, rawNotePath] = rest

  // /api/work packages
  if (!ref) {
    if (request.method === "GET")
      return json({ workPackages: listWorkPackages() })

    if (request.method === "POST") {
      const input = await body<{
        name?: string
        description?: string
        investigation?: string
        color?: string
        branchName?: string
        investigationRef?: string
      }>(request)
      if (!input.name) return fail("A work package needs a name.")
      const workPackage =
        input.investigation !== undefined && !input.investigationRef
          ? createInvestigatedWorkPackage({
              name: input.name,
              description: input.description ?? input.investigation,
              investigationBrief: input.investigation,
              color: input.color,
              branchName: input.branchName,
            })
          : createWorkPackage({
              name: input.name,
              description: input.description,
              color: input.color,
              branchName: input.branchName,
              investigationRef: input.investigationRef,
            })
      return json({ workPackage, workPackages: listWorkPackages() }, 201)
    }

    return fail("Method not allowed.", 405)
  }

  // /api/work packages/reorder — the empty work packages' order, and how ties are settled.
  if (ref === "reorder") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ refs?: unknown }>(request)
    if (
      !Array.isArray(input.refs) ||
      !input.refs.every((one) => typeof one === "string")
    ) {
      return fail(
        "refs must be an array of work package references, in their new order.",
      )
    }
    return json({ workPackages: reorderWorkPackages(input.refs as string[]) })
  }

  // /api/work packages/:ref
  if (!action) {
    if (request.method === "GET") {
      // The work package page wants the branch's live Git state and the work order too,
      // and one read is what keeps them consistent with each other.
      return json({ workPackage: getWorkPackageDetail(ref) })
    }

    if (request.method === "PATCH") {
      const input = await body<{
        name?: string
        description?: string
        color?: string
        branchName?: string
      }>(request)
      updateWorkPackage(ref, input)
      return json({ workPackages: listWorkPackages(), tasks: listTasks() })
    }

    if (request.method === "DELETE") {
      // The tasks are kept and turned loose; saying which ones is the whole
      // reassurance a delete confirmation needs.
      const result = deleteWorkPackage(ref)
      return json({
        deleted: result.ref,
        released: result.released,
        workPackages: listWorkPackages(),
        tasks: listTasks(),
      })
    }

    return fail("Method not allowed.", 405)
  }

  // /api/work packages/:ref/investigation — migration path for work packages created before
  // the current UI made the investigation brief part of every work package.
  if (action === "investigation") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ brief?: string }>(request)
    const investigation = ensureWorkPackageInvestigation(ref, input.brief)
    return json({
      investigation,
      workPackage: getWorkPackageDetail(ref),
      workPackages: listWorkPackages(),
    })
  }

  // /api/work packages/:ref/note-links — reference material for an investigation or
  // for the work package as a whole. The note remains an ordinary Markdown file.
  if (action === "note-links") {
    const workPackage = requireWorkPackage(ref)
    if (rawNotePath !== undefined) {
      if (request.method !== "DELETE") return fail("Method not allowed.", 405)
      detachNote(
        "work-package",
        workPackage.ref,
        decodeURIComponent(rawNotePath),
      )
      return json({ workPackage: getWorkPackageDetail(workPackage.ref) })
    }
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ path?: unknown }>(request)
    if (typeof input.path !== "string" || !input.path.trim()) {
      return fail("A note path is required.")
    }
    const note = readNote(input.path)
    attachNote("work-package", workPackage.ref, note.path)
    return json({ workPackage: getWorkPackageDetail(workPackage.ref) }, 201)
  }

  // /api/work packages/:ref/advance — sign the whole work package off in one go.
  if (action === "advance") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ status?: unknown }>(request)
    if (input.status !== "verified" && input.status !== "closed") {
      return fail("status must be 'verified' or 'closed'.")
    }
    const result = await advanceWorkPackage(ref, input.status)
    return json({
      workPackage: result.workPackage,
      outcomes: result.outcomes,
      workPackages: listWorkPackages(),
      tasks: listTasks(),
    })
  }

  // /api/work packages/:ref/run — work the whole work package unattended, a fresh headless
  // agent per task, this server driving the queue between them.
  if (action === "run") {
    if (request.method === "POST") {
      const input = await body<{
        harness?: string
        model?: string
        permissionMode?: string
        extra?: string
        excluded?: unknown
      }>(request)

      if (!input.harness) return fail("A harness is required.")
      if (
        input.excluded !== undefined &&
        (!Array.isArray(input.excluded) ||
          input.excluded.some((ref) => typeof ref !== "string"))
      ) {
        return fail("excluded must be an array of task refs.")
      }
      if (
        input.permissionMode !== undefined &&
        !AGENT_PERMISSION_MODES.includes(
          input.permissionMode as AgentPermissionMode,
        )
      ) {
        return fail(
          `permissionMode must be one of: ${AGENT_PERMISSION_MODES.join(", ")}.`,
        )
      }

      const started = startWorkPackageRun({
        workPackageRef: ref,
        harness: input.harness,
        model: input.model ?? "",
        // Nobody is watching any of these runs, so the only mode that can finish
        // is the one that never asks. Overridable, but not by omission.
        permissionMode:
          (input.permissionMode as AgentPermissionMode | undefined) ??
          "bypassPermissions",
        extra: input.extra ?? "",
        excluded: (input.excluded as string[] | undefined) ?? [],
      })

      return json(
        {
          workPackageRun: started.workPackageRun,
          run: started.run,
          workPackage: getWorkPackageDetail(ref),
        },
        201,
      )
    }

    // Stopping kills the agent in flight; the tasks already merged stay merged.
    if (request.method === "DELETE") {
      const workPackage = getWorkPackageDetail(ref)
      if (!workPackage.run) return fail(`${ref} has no run to stop.`)
      const workPackageRun = stopWorkPackageRun(workPackage.run.id)
      return json({ workPackageRun, workPackage: getWorkPackageDetail(ref) })
    }

    return fail("Method not allowed.", 405)
  }

  // /api/work packages/:ref/runs — what the work package has been run through before.
  if (action === "runs") {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    return json({ runs: listWorkPackageRuns(ref) })
  }

  return fail("Unknown endpoint.", 404)
}

/* ------------------------------------------------------------- baselines */

async function handleBaselines(
  request: Request,
  rest: string[],
): Promise<Response> {
  const [action] = rest

  // /api/baselines — the last run, joined with what has been approved.
  if (!action) {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    return json({ report: await readBaselines() })
  }

  // /api/baselines/run — re-drives the browser, optionally for named scenarios.
  if (action === "run") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ scenarios?: unknown }>(request).catch(
      () => ({}) as Record<string, never>,
    )
    if (
      input.scenarios !== undefined &&
      (!Array.isArray(input.scenarios) ||
        input.scenarios.some((one) => typeof one !== "string"))
    ) {
      return fail("scenarios must be an array of scenario names.")
    }
    // A non-zero exit means "something drifted", which is a result rather than
    // a failure — so it rides along with the report instead of becoming a 500.
    return json(await runBaselines((input.scenarios as string[]) ?? []))
  }

  // /api/baselines/approve — promote one scenario's capture to its baseline.
  if (action === "approve") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ scenario?: unknown }>(request)
    if (typeof input.scenario !== "string" || !input.scenario.trim()) {
      return fail("A scenario name is required.")
    }
    return json({ report: await approveBaseline(input.scenario) })
  }

  return fail("Unknown endpoint.", 404)
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const segments = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
  const [head, ...rest] = segments

  if (head === "meta") {
    return json({
      statuses: STATUSES,
      priorities: PRIORITIES,
      repoRoot: ws.repoRoot,
      aioVrDir: ws.aioVrDir,
      aioVrInstalled: aioVrAvailable(),
      aioVrWorkspaceExists: existsSync(ws.aioVrDir),
      notes: notesWorkspaceInfo(),
      tools: toolAvailability(),
    })
  }

  if (head === "events") return handleEvents(request)

  if (head === "agents") return handleAgents(request, url, rest)

  if (head === "branches") return handleBranches(request, rest)

  if (head === "notes") return handleNotes(request, url, rest)

  if (head === "issues") return handleIssues(request, url, rest)

  if (head === "investigations") return handleInvestigations(request, url, rest)

  if (head === "work-packages") return handleWorkPackages(request, rest)

  if (head === "baselines") return handleBaselines(request, rest)

  // Screenshots are streamed from disk rather than copied into the database.
  if (head === "image") {
    const relativePath = url.searchParams.get("path")
    if (!relativePath) return fail("An image path is required.")

    const absolute = resolveArtifact(relativePath)
    if (!absolute)
      return fail("No such image inside the aio-vr workspace.", 404)

    return new Response(Bun.file(absolute), {
      headers: {
        // Checkpoint artefacts are rewritten in place by each `after` run, so
        // they must never be cached by the browser.
        "cache-control": "no-store",
      },
    })
  }

  if (head !== "tasks") return fail("Unknown endpoint.", 404)

  // /api/tasks
  if (rest.length === 0) {
    if (request.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined
      if (status && !isStatus(status))
        return fail(`Unknown status '${status}'.`)

      return json({
        tasks: listTasks({
          status: status as Status | undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          investigationRef: url.searchParams.get("investigation") ?? undefined,
          workPackageRef: url.searchParams.get("work-package") ?? undefined,
        }),
      })
    }

    if (request.method === "POST") {
      const input = await body<{
        title?: string
        description?: string
        priority?: string
        recommendedTier?: string | null
        tags?: unknown
        useGitWorkflow?: boolean
        branchName?: string
        investigationRef?: string
        workPackageRef?: string | null
        dependsOn?: unknown
        estimateUnits?: unknown
      }>(request)

      if (!input.title) return fail("A task needs a title.")
      if (input.priority && !isPriority(input.priority)) {
        return fail(`Unknown priority '${input.priority}'.`)
      }
      if (input.recommendedTier && !isModelTier(input.recommendedTier)) {
        return fail(`Unknown tier '${input.recommendedTier}'.`)
      }
      if (
        input.useGitWorkflow !== undefined &&
        typeof input.useGitWorkflow !== "boolean"
      ) {
        return fail("useGitWorkflow must be a boolean.")
      }

      return json(
        {
          task: createTask({
            title: input.title,
            description: input.description,
            priority: input.priority as never,
            recommendedTier: input.recommendedTier as never,
            tags: parseTags(input.tags),
            useGitWorkflow: input.useGitWorkflow,
            branchName: input.branchName,
            investigationRef: input.investigationRef,
            workPackageRef: input.workPackageRef,
            dependsOn: parseRefs(input.dependsOn, "dependsOn"),
            estimateUnits: parseUnits(input.estimateUnits),
          }),
        },
        201,
      )
    }

    return fail("Method not allowed.", 405)
  }

  // /api/tasks/reorder — the whole list, or just the rows a filtered view shows.
  if (rest[0] === "reorder") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ refs?: unknown }>(request)
    if (
      !Array.isArray(input.refs) ||
      !input.refs.every((ref) => typeof ref === "string")
    ) {
      return fail(
        "refs must be an array of task references, in their new order.",
      )
    }

    reorderTasks(input.refs as string[])
    return json({ tasks: listTasks() })
  }

  if (rest[0] === "combine" && rest[1] === "preview") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ refs?: unknown }>(request)
    if (
      !Array.isArray(input.refs) ||
      !input.refs.every((ref) => typeof ref === "string")
    )
      return fail("refs must be an array of task references.")
    const localBranches = git([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
    const base = defaultBaseBranch()
    // The preview does not fetch — opening the dialog should not touch the
    // network. It reads the range against the base as it stands, which is the
    // fork point either way unless the base has since absorbed these very
    // commits, and falls back to origin's copy when the base is not local yet.
    const previewBase = branchExists(base) ? base : `origin/${base}`
    return json({
      base,
      tasks: [...new Set(input.refs as string[])].map((ref) => {
        const task = getTaskDetail(ref)
        const candidates = localBranches.filter((name) =>
          name.toLowerCase().includes(`/${ref.toLowerCase()}-`),
        )
        const exists =
          !!task.branchName && localBranches.includes(task.branchName)
        return {
          task,
          exists,
          candidates,
          commits: exists
            ? readBranch(task.branchName!, previewBase).commits
            : [],
        }
      }),
    })
  }

  if (rest[0] === "combine" && rest[1] === "continue") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ branchName?: unknown }>(request)
    if (typeof input.branchName !== "string")
      return fail("A branch name is required.")
    return json(await continueCombine(input.branchName))
  }

  if (rest[0] === "combine") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{
      refs?: unknown
      branchName?: unknown
      closeTasks?: unknown
    }>(request)
    if (
      !Array.isArray(input.refs) ||
      !input.refs.every((ref) => typeof ref === "string")
    ) {
      return fail("refs must be an array of task references.")
    }
    if (typeof input.branchName !== "string")
      return fail("A branch name is required.")
    if (
      input.closeTasks !== undefined &&
      typeof input.closeTasks !== "boolean"
    ) {
      return fail("closeTasks must be a boolean.")
    }
    const result = await combineTasks(
      input.refs,
      input.branchName,
      input.closeTasks ?? true,
    )
    return json(
      {
        branchName: result.branchName,
        tasks: result.tasks,
        conflicted: result.conflicted,
        base: result.base,
      },
      201,
    )
  }

  // /api/tasks/asset — a screenshot streamed out of a task's attachment folder.
  // Named rather than pathed, so it cannot collide with a task ref.
  if (rest[0] === "asset") {
    if (request.method !== "GET") return fail("Method not allowed.", 405)
    const assetRef = url.searchParams.get("ref")
    const name = url.searchParams.get("name")
    if (!assetRef || !name)
      return fail("A task ref and attachment name are required.")

    const absolute = resolveTaskAsset(assetRef, name)
    if (!absolute) return fail("No such attachment on that task.", 404)
    // Attachments are immutable once written — a re-upload gets a new name — so
    // these are safe to cache.
    return new Response(Bun.file(absolute), {
      headers: { "cache-control": "private, max-age=300" },
    })
  }

  const [ref, action, phase] = rest

  // /api/tasks/:ref
  if (action === "close") {
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    return json({ task: await closeTask(ref!) })
  }
  if (!action) {
    if (request.method === "GET") return json({ task: getTaskDetail(ref!) })

    if (request.method === "PATCH") {
      const input = await body<{
        title?: string
        description?: string
        priority?: string
        recommendedTier?: string | null
        tags?: unknown
        useGitWorkflow?: boolean
        investigationRef?: string | null
        workPackageRef?: string | null
        branchName?: string
        dependsOn?: unknown
        estimateUnits?: unknown
      }>(request)

      if (input.priority && !isPriority(input.priority)) {
        return fail(`Unknown priority '${input.priority}'.`)
      }
      if (input.recommendedTier && !isModelTier(input.recommendedTier)) {
        return fail(`Unknown tier '${input.recommendedTier}'.`)
      }
      if (
        input.useGitWorkflow !== undefined &&
        typeof input.useGitWorkflow !== "boolean"
      ) {
        return fail("useGitWorkflow must be a boolean.")
      }
      if (input.useGitWorkflow === false && input.branchName !== undefined) {
        return fail(
          "A task cannot have a branch when its Git workflow is disabled.",
        )
      }

      if (input.branchName !== undefined)
        updateTaskBranchName(ref!, input.branchName)
      updateTask(ref!, {
        title: input.title,
        description: input.description,
        priority: input.priority as never,
        recommendedTier: input.recommendedTier as never,
        tags: parseTags(input.tags),
        useGitWorkflow: input.useGitWorkflow,
        investigationRef: input.investigationRef,
        workPackageRef: input.workPackageRef,
        dependsOn: parseRefs(input.dependsOn, "dependsOn"),
        estimateUnits: parseUnits(input.estimateUnits),
      })
      return json({ task: getTaskDetail(ref!) })
    }

    if (request.method === "DELETE") {
      deleteTask(ref!)
      return json({ deleted: ref })
    }

    return fail("Method not allowed.", 405)
  }

  // /api/tasks/:ref/dependencies — handled before the POST-only guard below,
  // because removing one blocker is a DELETE on the edge rather than a POST.
  if (action === "dependencies") {
    const blockerRef = rest[2]

    if (blockerRef !== undefined) {
      if (request.method !== "DELETE") return fail("Method not allowed.", 405)
      return json({
        task: getTaskDetail(
          removeDependency(ref!, decodeURIComponent(blockerRef)).ref,
        ),
      })
    }

    if (request.method === "POST") {
      const input = await body<{ dependsOn?: unknown }>(request)
      const refs = parseRefs(input.dependsOn, "dependsOn")
      if (!refs?.length) return fail("dependsOn must name at least one task.")
      for (const blocker of refs) addDependency(ref!, blocker)
      return json({ task: getTaskDetail(ref!) })
    }

    return fail("Method not allowed.", 405)
  }

  // /api/tasks/:ref/attachments — handled before the POST-only guard below,
  // for the same reason as dependencies: removing one is a DELETE.
  if (action === "attachments") {
    const attachmentName = rest[2]

    if (attachmentName !== undefined) {
      if (request.method !== "DELETE") return fail("Method not allowed.", 405)
      removeTaskAttachment(ref!, decodeURIComponent(attachmentName))
      return json({ task: getTaskDetail(ref!) })
    }

    if (request.method !== "POST") return fail("Method not allowed.", 405)

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return fail("Attachments must be uploaded as multipart/form-data.")
    }

    const uploaded = form
      .getAll("file")
      .filter((entry): entry is File => entry instanceof File)
    if (!uploaded.length) return fail("No file was uploaded.")

    const added = []
    for (const file of uploaded) {
      added.push(
        addTaskAttachment(
          ref!,
          file.name || "attachment",
          await file.arrayBuffer(),
        ),
      )
    }
    return json({ added, task: getTaskDetail(ref!) }, 201)
  }

  // /api/tasks/:ref/note-links — separate from /notes, which is the existing
  // free-form task history endpoint.
  if (action === "note-links") {
    const task = requireTask(ref!)
    if (phase !== undefined) {
      if (request.method !== "DELETE") return fail("Method not allowed.", 405)
      detachNote("task", task.ref, decodeURIComponent(phase))
      return json({ task: getTaskDetail(task.ref) })
    }
    if (request.method !== "POST") return fail("Method not allowed.", 405)
    const input = await body<{ path?: unknown }>(request)
    if (typeof input.path !== "string" || !input.path.trim()) {
      return fail("A note path is required.")
    }
    const note = readNote(input.path)
    attachNote("task", task.ref, note.path)
    return json({ task: getTaskDetail(task.ref) }, 201)
  }

  if (request.method !== "POST") return fail("Method not allowed.", 405)

  // /api/tasks/:ref/status
  if (action === "status") {
    const input = await body<{
      status?: string
      note?: string
      merge?: boolean
    }>(request)
    if (!input.status || !isStatus(input.status)) {
      return fail(`status must be one of: ${STATUSES.join(", ")}.`)
    }

    setStatus(ref!, input.status, input.note)

    // Dev complete is when the work joins the rest of its work package's, exactly as
    // `tasks done` does it. A conflict is reported alongside the task rather
    // than as a failed request: the status change did happen, and the caller
    // needs to be told both things.
    let mergeError: string | null = null
    const task = requireTask(ref!)
    if (
      input.status === "dev_complete" &&
      input.merge !== false &&
      task.useGitWorkflow
    ) {
      mergeError = mergeIntoWorkPackageBranch(ref!)
    }
    return json({ task: getTaskDetail(ref!), mergeError })
  }

  // /api/tasks/:ref/merge — the work package-branch merge on its own, for after a
  // conflict has been resolved by hand or a merge was skipped.
  if (action === "merge") {
    const mergeError = mergeIntoWorkPackageBranch(ref!)
    if (mergeError) return fail(mergeError)
    return json({ task: getTaskDetail(ref!), mergeError: null })
  }

  // /api/tasks/:ref/notes
  if (action === "notes") {
    const input = await body<{ note?: string }>(request)
    if (!input.note) return fail("A note is required.")

    addNote(ref!, input.note)
    return json({ task: getTaskDetail(ref!) })
  }

  // /api/tasks/:ref/work package — what dropping a row onto a work package sends.
  //
  // Separate from PATCH because it is one gesture with two effects: the row
  // changes work package *and* lands somewhere, and the drop decides where. `reposition`
  // false leaves the queue alone for a caller that is about to reorder it
  // itself, which is exactly what the drag does.
  if (action === "work-package") {
    const input = await body<{
      workPackageRef?: unknown
      reposition?: unknown
    }>(request)
    if (
      input.workPackageRef !== null &&
      typeof input.workPackageRef !== "string"
    ) {
      return fail(
        "workPackageRef must be a work package reference, or null to remove the task from its work package.",
      )
    }
    if (
      input.reposition !== undefined &&
      typeof input.reposition !== "boolean"
    ) {
      return fail("reposition must be a boolean.")
    }

    setWorkPackage(ref!, input.workPackageRef, { reposition: input.reposition })
    return json({
      task: getTaskDetail(ref!),
      tasks: listTasks(),
      workPackages: listWorkPackages(),
    })
  }

  // /api/tasks/:ref/move — one task, relative to the list it is already in.
  if (action === "move") {
    const input = await body<{ to?: string; ref?: string }>(request)
    const to = input.to
    if (to === "top" || to === "bottom" || to === "up" || to === "down") {
      return json({ tasks: moveTask(ref!, { to }) })
    }
    if (to === "before" || to === "after") {
      if (!input.ref) return fail(`Moving '${to}' needs the ref to move ${to}.`)
      return json({ tasks: moveTask(ref!, { to, ref: input.ref }) })
    }
    return fail("to must be one of: top, bottom, up, down, before, after.")
  }

  // /api/tasks/:ref/checkpoint/:phase
  if (action === "checkpoint") {
    if (phase !== "before" && phase !== "after") {
      return fail("Checkpoint phase must be 'before' or 'after'.")
    }

    const input = await body<{
      scenarios?: string[]
      folders?: string[]
      minPercent?: number
      allowMissing?: boolean
      retro?: boolean
      at?: string
      settleSeconds?: number
    }>(request).catch(() => ({}) as Record<string, never>)

    const task = requireTask(ref!)
    const options = {
      scenarios: input.scenarios,
      folders: input.folders,
      minPercent: input.minPercent,
      allowMissing: input.allowMissing,
      inheritStdio: false,
    }

    // A retroactive before moves the working tree to an older commit and back.
    // It is only offered for 'before': there is no sense in which 'after' could
    // be captured anywhere but where the work now stands.
    if (phase === "before" && (input.retro || input.at)) {
      const target = resolveRetroTarget(task, input.at)
      const retro = await captureBeforeRetro(task, target, {
        ...options,
        settleSeconds: input.settleSeconds,
      })
      return json({
        run: retro,
        target: retro.target,
        restoredTo: retro.restoredTo,
        task: getTaskDetail(ref!),
      })
    }

    const result =
      phase === "before"
        ? await captureBefore(task, options)
        : await captureAfter(task, options)

    return json({ run: result, task: getTaskDetail(ref!) })
  }

  return fail("Unknown endpoint.", 404)
}

/* ----------------------------------------------------------------- static */

const indexPath = join(ws.distDir, "index.html")

function serveStatic(url: URL): Response {
  if (!existsSync(indexPath)) {
    return new Response(
      "The web UI has not been built yet.\n\nRun `bun run build` in the " +
        "work-task-manager checkout, or use `tasks web --dev` for the " +
        "hot-reloading dev server.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    )
  }

  // Serve the requested asset when it exists, otherwise fall back to index.html
  // so client-side routes survive a refresh.
  const candidate = join(ws.distDir, url.pathname)
  if (
    candidate.startsWith(ws.distDir) &&
    url.pathname !== "/" &&
    existsSync(candidate)
  ) {
    return new Response(Bun.file(candidate))
  }

  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

// Headless agent runs are children of this process, so a restart ended any that
// were in flight. Settle those rows before anything can read them — and the
// work package runs that were driving some of them, which are stopped rather than
// picked up again: relaunching agents at boot is not a decision a restart makes.
reconcileRuns()
reconcileWorkPackageRuns()

// Start watching before the first tab connects, so the opening revisions a
// client is handed are already moving with the workspace.
ensureWatchers()

const server = Bun.serve({
  port,
  // Checkpoint captures drive a real browser through every scenario, which
  // comfortably outlives the default request timeout.
  idleTimeout: 240,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname.startsWith("/api")) {
      try {
        const response = await handleApi(request, url)
        // Anything that succeeded and was not a read changed something. The file
        // watchers see these writes too; saying so directly is what keeps live
        // updates working on a filesystem whose change notifications do not.
        if (request.method !== "GET" && response.ok) {
          announceChange(
            url.pathname.startsWith("/api/notes") ? "notes" : "tasks",
          )
        }
        return response
      } catch (error) {
        return errorResponse(error)
      }
    }

    return serveStatic(url)
  },
})

console.log(`tasks api  → http://localhost:${server.port}`)
console.log(`repo root  → ${ws.repoRoot}`)
console.log(`database   → ${ws.dbPath}`)
console.log(`workspace  → ${ws.tasksDir}`)
if (!existsSync(indexPath)) {
  console.log(
    `web ui     → not built (run \`bun run build\` in ${packageRoot})`,
  )
}
