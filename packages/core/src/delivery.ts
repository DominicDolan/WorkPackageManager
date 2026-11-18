/**
 * Getting finished work onto branches and signing it off: combining task
 * branches into a delivery branch, merging a task into its targets, closing
 * and advancing tasks, and editing the branches that carry them.
 *
 * Every rule here used to live in the HTTP router. It is domain logic, so it
 * lives with the domain: the API, the CLI and any embedding server get the
 * same behaviour, and a route only has to translate a request into a call.
 */
import { cleanCheckpoint } from "./aiovr"
import {
    branchExists,
    builtOnTopOf,
    currentBranch,
    defaultBaseBranch,
    readBranch,
    refreshBaseBranch,
    type BaseRefresh,
} from "./branches"
import { checksProgress, configuredChecks, startChecks } from "./checks"
import {
    checksSupervised,
    checksSupervision,
    clearChecksSupervision,
    startSupervisedChecks,
} from "./checksSupervisor"
import { lazyWorkspace } from "./config/paths"
import {
    clearRebaseSupervision,
    rebaseSupervised,
    superviseRebaseConflict,
} from "./rebaseSupervisor"
import {
    createWorkPackageBranch,
    findTask,
    getTaskDetail,
    recordCombine,
    recordCombinedBranch,
    renameCombinedBranch,
    requireCombinedBranch,
    requireTask,
    requireWorkPackageBranch,
    setBranchTasks,
    setStatus,
    updateCombinedBranch,
    updateTaskBranchName,
    updateWorkPackageBranch,
    validateBranchName,
    type CreateWorkPackageBranchInput,
} from "./repo"
import { unattendedSupervisor } from "./agents"
import {
    getWorkPackageDetail,
    mergeTaskIntoTargetBranches,
    primaryTargetOf,
    rebaseBranchOnBase,
    syncBranchTasks,
    workPackageBranchDetail,
} from "./workPackageBranch"
import {
    STATUS_LABELS,
    type BranchTaskSync,
    type CombinedBranchDetail,
    type RunSupervisor,
    type Status,
    type Task,
    type WorkPackageAdvanceOutcome,
    type WorkPackageBranch,
} from "@work-task-manager/shared"

const ws = lazyWorkspace()

function git(args: string[]): { code: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["git", ...args], { cwd: ws.repoRoot })
    return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    }
}

/**
 * Merge a task into its target branches, flattened to "what went wrong, if
 * anything". A task with no target branch is not a problem — there is simply
 * nothing to merge into — so that reads as success.
 */
export function mergeIntoTargetBranches(ref: string): string | null {
    try {
        const result = mergeTaskIntoTargetBranches(ref)
        const failed = result.targets.filter((one) => !one.merged)
        if (!failed.length) return null
        return failed
            .map(
                (one) =>
                    `${ref}'s commits do not replay onto '${one.branch}' — they collide with work already there. ` +
                    `Nothing was changed on that branch. Resolve it by hand, then merge ${ref} again to register it.\n${one.conflict}`,
            )
            .join("\n\n")
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
}

export function cherryPickInProgress(): boolean {
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
export async function advanceWorkPackage(
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
                outcome.error =
                    error instanceof Error ? error.message : String(error)
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
export async function closeTask(
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

export interface CombineResult {
    branchName: string
    tasks: ReturnType<typeof getTaskDetail>[]
    conflicted: boolean
    /** What the branch was cut from, and what had to happen to get it current. */
    base: { branch: string } & BaseRefresh
}

export async function combineTasks(
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
        if (!task.branchName)
            throw new Error(`${task.ref} has no assigned branch.`)
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
        const owned = primaryTargetOf(task)
        if (!owned || !branchExists(owned.branchName)) continue
        if (!builtOnTopOf(baseBranch, owned.branchName, task.branchName!))
            continue
        throw new Error(
            `${task.ref} is on ${owned.workPackageRef}'s '${owned.label}' branch, and its branch is built on ` +
                `'${owned.branchName}' — combining it here would carry that branch's other tasks with it. ` +
                `Deliver it from '${owned.branchName}' instead.`,
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

export async function continueCombine(
    branchName: string,
): Promise<{ branchName: string; tasks: ReturnType<typeof getTaskDetail>[] }> {
    const branch = requireCombinedBranch(branchName)
    if (branch.combineState !== "conflict")
        throw new Error(
            `'${branchName}' is not waiting for a conflict resolution.`,
        )
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
        if (
            git(["cherry-pick", branch.combinePendingCommits[index]!]).code !==
            0
        ) {
            recordCombine({
                branchName,
                baseBranch: branch.baseBranch,
                taskRefs: branch.taskRefs,
                combineState: "conflict",
                combinePendingCommits: branch.combinePendingCommits.slice(
                    index + 1,
                ),
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

/** A stored branch plus its live Git state and the tasks it carries. Tasks are
 *  looked up leniently — a combined branch outlives the tasks it was built from,
 *  and a deleted one should not break the view. */
export function branchDetail(branchName: string): CombinedBranchDetail {
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
        checksSupervision: checksSupervision(branch.branchName),
    }
}

/* --------------------------------------------------------- combine preview */

/**
 * What combining `refs` would pick, without touching anything: each task, its
 * branch (or the local branches that look like it when the assigned one is
 * gone) and the commits it would contribute.
 */
export function previewCombine(refs: string[]) {
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
    return {
        base,
        tasks: [...new Set(refs)].map((ref) => {
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
    }
}

/* ---------------------------------------------------------- task status */

/**
 * Move a task to `status`. Dev complete is when the work joins the rest of its
 * work package's, exactly as `tasks done` does it, unless `merge` is false. A
 * conflict is reported alongside the task rather than thrown: the status change
 * did happen, and the caller needs to be told both things.
 */
export function setTaskStatus(
    ref: string,
    status: Status,
    note?: string,
    merge = true,
): { task: ReturnType<typeof getTaskDetail>; mergeError: string | null } {
    setStatus(ref, status, note)
    let mergeError: string | null = null
    if (status === "dev_complete" && merge && requireTask(ref).useGitWorkflow)
        mergeError = mergeIntoTargetBranches(ref)
    return { task: getTaskDetail(ref), mergeError }
}

/* ------------------------------------------------- combined branch editing */

export interface CombinedBranchEdit {
    branchName?: string
    baseBranch?: string
    remoteBranch?: string
    prTitle?: string
    prBody?: string
}

/**
 * Edit a delivery branch. Renaming renames the Git branch too; the PR target
 * must exist locally. Returns the branch's name afterwards.
 */
export function editCombinedBranch(
    name: string,
    input: CombinedBranchEdit,
): string {
    let savedName = name
    if (input.branchName !== undefined) {
        const next = validateBranchName(input.branchName)
        if (next !== name) {
            if (branchExists(next))
                throw new Error(`Branch '${next}' already exists locally.`)
            const renamed = git(["branch", "-m", name, next])
            if (renamed.code !== 0)
                throw new Error(
                    renamed.stderr.trim() || `Could not rename '${name}'.`,
                )
            renameCombinedBranch(name, next)
            savedName = next
        }
    }

    if (input.baseBranch !== undefined) {
        const base = validateBranchName(input.baseBranch)
        if (!branchExists(base))
            throw new Error(
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
    return savedName
}

/* ------------------------------------------------------------ branch checks */

export interface BranchChecksRequest {
    /** Run only this check. */
    check?: string
    /** Run from this check to the end. */
    from?: string
    /** Re-run only what did not pass last time. */
    resume?: boolean
    supervisor?: RunSupervisor | null
}

/**
 * Start the repository's configured checks against a delivery branch. Started,
 * not awaited: a suite outlives any request worth holding open, so callers
 * follow `checksRunning` on the branch.
 */
export function startBranchChecks(
    name: string,
    input: BranchChecksRequest,
): void {
    const branch = requireCombinedBranch(name)
    const checks = configuredChecks()
    if (!checks.length)
        throw new Error(
            'No checks are configured — add "checks" to .tasks/tasks.config.json.',
        )
    if (
        input.check !== undefined &&
        !checks.some((check) => check.name === input.check)
    )
        throw new Error("Unknown check.")
    if (
        input.from !== undefined &&
        !checks.some((check) => check.name === input.from)
    )
        throw new Error("Unknown starting check.")
    if (
        Number(input.check !== undefined) +
            Number(input.from !== undefined) +
            Number(input.resume === true) >
        1
    )
        throw new Error("Choose a single check, a starting check, or resume.")
    if (
        (input.check !== undefined || input.from !== undefined) &&
        input.supervisor
    )
        throw new Error("A supervisor runs the whole suite, not one check.")
    if (checksSupervised(branch.branchName))
        throw new Error(
            "The checks on this branch are running with a supervisor. Stop it first.",
        )

    const base = branch.baseBranch ?? defaultBaseBranch()
    if (input.supervisor) {
        startSupervisedChecks({
            branch: branch.branchName,
            base,
            resume: input.resume === true,
            previous: branch.checks,
            supervisor: input.supervisor,
        })
        return
    }
    clearChecksSupervision(branch.branchName)
    startChecks({
        branch: branch.branchName,
        base,
        check: input.check,
        from: input.from,
        resume: input.resume === true,
        previous: branch.checks,
    })
}

/* ----------------------------------------------- work package branch editing */

/** Drop the tasks whose commits failed to replay from a branch's task list. */
function withoutFailed(
    branch: WorkPackageBranch,
    sync: BranchTaskSync,
): WorkPackageBranch {
    if (!sync.failed.length) return branch
    const failed = new Set(sync.failed.map((ref) => ref.toLowerCase()))
    return setBranchTasks(
        branch.id,
        branch.taskRefs.filter((ref) => !failed.has(ref.toLowerCase())),
    )
}

/**
 * Add a branch to a work package. Finished tasks it starts with are merged in
 * straight away, so the branch shows their commits from the moment it is added.
 *
 * A branch tab is a statement about what has actually landed on its Git
 * branch, so a task whose commits fail to replay is left off it (to be
 * resolved and added again) rather than listed as if it had made it across.
 */
export function addWorkPackageBranch(input: CreateWorkPackageBranchInput) {
    const branch = createWorkPackageBranch(input)
    const git = syncBranchTasks(branch, [])
    const saved = withoutFailed(branch, git)
    return { branch: workPackageBranchDetail(saved), git }
}

export interface WorkPackageBranchEdit {
    label?: string
    branchName?: string
    baseBranch?: string | null
    /** The full new task list; tasks added are merged in, as on create. */
    taskRefs?: string[]
}

export function editWorkPackageBranch(
    id: number,
    input: WorkPackageBranchEdit,
) {
    updateWorkPackageBranch(id, {
        label: input.label,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
    })
    let git: BranchTaskSync | undefined
    let saved = requireWorkPackageBranch(id)
    if (input.taskRefs !== undefined) {
        const before = saved.taskRefs
        saved = setBranchTasks(id, input.taskRefs)
        git = syncBranchTasks(saved, before)
        saved = withoutFailed(saved, git)
    }
    return { branch: workPackageBranchDetail(saved), git }
}

/**
 * Rebase a work package branch onto its base's tip. With a supervisor, a
 * conflict is handed to an unattended agent to resolve; the supervisor setting
 * is checked first, so one that could never work fails without touching the
 * branch.
 */
export function rebaseWorkPackageBranch(
    branch: WorkPackageBranch,
    supervisor: RunSupervisor | null,
) {
    if (rebaseSupervised(branch.branchName))
        throw new Error(
            "A supervisor is still resolving this branch's rebase. Stop it first.",
        )
    const unattended =
        supervisor && unattendedSupervisor(supervisor, "resolve a conflict")
    clearRebaseSupervision(branch.branchName)
    const from = currentBranch()
    const result = rebaseBranchOnBase(branch)
    const supervision =
        result.conflict && unattended
            ? superviseRebaseConflict({
                  conflict: result.conflict,
                  supervisor: unattended,
                  pushed: result.pushed,
                  from,
              })
            : null
    return {
        ...result,
        supervision,
        branch: workPackageBranchDetail(requireWorkPackageBranch(branch.id)),
    }
}
