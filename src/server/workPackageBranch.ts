import {
    branchExists,
    commitsIn,
    createBranch,
    currentBranch,
    defaultBaseBranch,
    fastForward,
    hasMerges,
    isAncestor,
    isPushed,
    mergeBase,
    mergeInProgress,
    moveBranch,
    patchesApplied,
    patchIds,
    rebaseInProgress,
    rebaseOnto,
    rebaseRangeOnto,
    readBranch,
    rebuildBranch,
    refExists,
    refreshBaseBranch,
    replayRange,
    resolveCommit,
    switchBranch,
    workingTreeClean,
} from "./branches"
import {
    findCombinedBranch,
    findWorkPackageBranchByName,
    latestWorkPackageRun,
    listInvestigations,
    listWorkPackageBranches,
    listWorkPackages,
    listTasks,
    branchedFrom,
    ownCommitsFrom,
    recordCombine,
    recordGitError,
    recordOwnCommitsFrom,
    registerTaskOnBranch,
    requireWorkPackage,
    requireTask,
    unregisterTaskFromBranch,
} from "./repo"
import {
    dependencyOrder,
    type BranchTaskSync,
    unmetDependencies,
    type GitConflict,
    type Task,
    type WorkPackageBranch,
    type WorkPackageBranchDetail,
    type WorkPackageDetail,
} from "../shared/types"
import { listWorkRuns, workRunDetail } from "./workRuns"
import { rebaseSupervision } from "./rebaseSupervisor"

/**
 * A work package's branches as integration branches.
 *
 * A work package is a piece of work made of several tasks, and each of its
 * branches is where some of that work adds up. A task is assigned to one or more
 * of them: it is cut from the first, and `tasks done` merges it into every one.
 * What a branch's PR contains is then exactly its finished tasks, and nothing
 * else has to be selected by hand.
 *
 * Every merge also registers the task on the branch's delivery record, so the
 * Branches view can answer "what is on this branch" from the database rather
 * than from Git archaeology.
 */

/** The branches a task has to land on, first first. Assignments naming a branch
 *  that has since gone are skipped: the task is still perfectly workable. */
export function targetBranchesOf(task: Task): WorkPackageBranch[] {
    return task.targetBranches
        .map((name) => findWorkPackageBranchByName(name))
        .filter((branch): branch is WorkPackageBranch => branch !== null)
}

/** The branch a task is cut from, or null when it has no target branch. */
export function primaryTargetOf(task: Task): WorkPackageBranch | null {
    return targetBranchesOf(task)[0] ?? null
}

/** What a work package branch is cut from and compared against. */
export function baseOf(branch: WorkPackageBranch): string {
    return branch.baseBranch ?? defaultBaseBranch()
}

/**
 * The work package branch, created from its base if Git does not have it yet.
 *
 * Creating it lazily is what keeps a work package cheap: filing tasks under a heading
 * should not put a branch in the repository, and the first task to actually be
 * worked is the moment one is needed. It is created without being checked out,
 * so this never moves the user off what they are on.
 */
export function ensureWorkPackageBranch(branch: WorkPackageBranch): {
    branch: string
    created: boolean
} {
    const name = branch.branchName
    if (branchExists(name)) return { branch: name, created: false }
    if (branch.origin === "existing") {
        throw new Error(
            `'${name}' was adopted as ${branch.workPackageRef}'s '${branch.label}' branch, but it no longer exists locally.`,
        )
    }

    const base = baseOf(branch)
    // `origin/<base>` covers a fresh clone where the base has never been checked
    // out locally — `refExists` resolves either form.
    const start = branchExists(base) ? base : `origin/${base}`
    if (!refExists(start)) {
        throw new Error(
            `Cannot create ${branch.workPackageRef}'s branch '${name}': its base '${base}' exists neither locally nor on origin.`,
        )
    }

    createBranch(name, start)
    return { branch: name, created: true }
}

/** What happened on one of a task's target branches. */
export interface TargetMergeOutcome {
    workPackageRef: string
    label: string
    branch: string
    /** True when the branch had to be created for this merge. */
    createdBranch: boolean
    /** The task's work is on the branch, either just now or already. */
    merged: boolean
    alreadyMerged: boolean
    /** Set when the task's commits could not be replayed onto the branch.
     *  Nothing is left half-done: the rebase is aborted and every branch is
     *  exactly as it was. */
    conflict: string
}

export interface TaskMergeResult {
    /** The task's own branch — named in the conflict message, since resolving one
     *  by hand means rebasing that branch specifically. */
    taskBranch: string
    /** One per target branch, first first. Empty when the task has none — the
     *  caller reports that as "nothing to merge into", not as a failure. */
    targets: TargetMergeOutcome[]
    /** Where the caller was before, and is again — including after a conflict,
     *  which no longer strands anyone mid-operation. */
    returnedTo: string | null
}

/**
 * Put a task's commits on every branch it targets, and register it on each.
 *
 * The **first** target is merged the way a work package branch always has been:
 * the task's commits are replayed onto the branch's tip, and the branch is
 * fast-forwarded to them. No merge commit, so the branch ends up a plain list of
 * the commits its tasks produced, in the order they were finished — which is
 * what somebody reviewing the PR wants to read. Rebasing rewrites the task
 * branch, so a branch that has been pushed is refused rather than quietly
 * requiring a force-push afterwards.
 *
 * Every **other** target gets a copy of just the task's own commits — the range
 * recorded when it landed on the first — replayed the same way onto a scratch
 * branch. The task branch itself is not touched again.
 *
 * A collision on the first target stops everything; one on a later target is
 * reported and the rest carry on, since they do not depend on each other. Once
 * the user has resolved it themselves, running this again finds the work
 * already there and simply registers it.
 */
/**
 * Merge a task into every one of its target branches, and record on the task
 * whether that worked — so a failure shows in the web app, not only in the
 * terminal (or agent transcript) that ran `tasks done`.
 */
export function mergeTaskIntoTargetBranches(ref: string): TaskMergeResult {
    let result: TaskMergeResult
    try {
        result = mergeTaskIntoTargetBranchesUnrecorded(ref)
    } catch (error) {
        recordGitError(
            ref,
            error instanceof Error ? error.message : String(error),
        )
        throw error
    }
    const failed = result.targets.filter((one) => !one.merged)
    recordGitError(
        ref,
        failed.length
            ? failed
                  .map((one) =>
                      `Could not merge into '${one.branch}'.\n${one.conflict}`.trim(),
                  )
                  .join("\n\n")
            : null,
    )
    return result
}

function mergeTaskIntoTargetBranchesUnrecorded(ref: string): TaskMergeResult {
    const task = requireTask(ref)
    const targets = targetBranchesOf(task)
    if (!targets.length) {
        return {
            taskBranch: task.branchName ?? "",
            targets: [],
            returnedTo: null,
        }
    }

    if (!task.branchName)
        throw new Error(
            `${task.ref} has no assigned branch, so there is nothing to merge.`,
        )
    const taskBranch = task.branchName
    if (!branchExists(taskBranch)) {
        throw new Error(
            `${task.ref}'s branch '${taskBranch}' does not exist locally, so there is nothing to merge.`,
        )
    }
    if (mergeInProgress()) {
        throw new Error(
            `A merge is already in progress on '${currentBranch() ?? "HEAD"}'. Resolve and commit it (or 'git merge --abort') first.`,
        )
    }
    if (rebaseInProgress()) {
        throw new Error(
            `A rebase is already in progress on '${currentBranch() ?? "HEAD"}'. Finish it ('git rebase --continue') or cancel it ('git rebase --abort') first.`,
        )
    }
    if (!workingTreeClean()) {
        throw new Error(
            `The working tree must be clean before merging ${task.ref} into ${targets
                .map((one) => `'${one.branchName}'`)
                .join(", ")}. Commit or stash first, or pass --no-merge.`,
        )
    }

    const from = currentBranch()
    const outcomes: TargetMergeOutcome[] = []
    try {
        const [primary, ...others] = targets
        const first = mergeIntoPrimary(task.ref, taskBranch, primary!)
        outcomes.push(first)
        if (first.merged) {
            for (const other of others)
                outcomes.push(mergeIntoSecondary(task.ref, taskBranch, other))
        }
    } finally {
        if (from && currentBranch() !== from) switchBranch(from)
    }

    return { taskBranch, targets: outcomes, returnedTo: from }
}

function outcomeFor(
    target: WorkPackageBranch,
    created: boolean,
): TargetMergeOutcome {
    return {
        workPackageRef: target.workPackageRef,
        label: target.label,
        branch: target.branchName,
        createdBranch: created,
        merged: false,
        alreadyMerged: false,
        conflict: "",
    }
}

function mergeIntoPrimary(
    ref: string,
    taskBranch: string,
    target: WorkPackageBranch,
): TargetMergeOutcome {
    const { branch, created } = ensureWorkPackageBranch(target)
    const outcome = outcomeFor(target, created)

    // Already contained: nothing to merge, but the registration may still be
    // missing — a conflict resolved by hand ends up exactly here.
    if (isAncestor(taskBranch, branch)) {
        registerTaskOnBranch(branch, ref, baseOf(target))
        return { ...outcome, merged: true, alreadyMerged: true }
    }

    // Rewriting a branch somebody else may have fetched is not this tool's call
    // to make, and it is not recoverable by them noticing later.
    if (isPushed(taskBranch)) {
        throw new Error(
            `${ref}'s branch '${taskBranch}' has been pushed, so replaying it onto ` +
                `'${branch}' would need a force-push afterwards. Merge it by hand, or delete the ` +
                "remote branch first if nothing depends on it.",
        )
    }

    // The task's own commits are whatever lands on top of where the branch is
    // now, so its tip before the merge is where they start.
    const tipBefore = resolveCommit(branch)

    // Replay first, fast-forward second. The rebase is what makes the branch
    // a straight list rather than a chain of merge commits.
    //
    // Only the task's own commits are replayed: those after the point it was
    // cut from. A plain `git rebase <target> <task>` replays everything the
    // target lacks, so a task cut from somewhere else — a --from branch, a
    // dependency, a target that is not the first — carried that branch's whole
    // history onto the target as flattened copies (T-197: 63 rewritten master
    // commits fast-forwarded onto a stale work package branch).
    const start = ownCommitsStart(ref, taskBranch, target)
    const replayed = start
        ? rebaseRangeOnto(start, taskBranch, branch)
        : rebaseOnto(taskBranch, branch)
    if (!replayed.rebased) return { ...outcome, conflict: replayed.conflict }

    switchBranch(branch)
    const forwarded = fastForward(taskBranch)
    if (!forwarded.merged) return { ...outcome, conflict: forwarded.conflict }

    if (tipBefore) recordOwnCommitsFrom(ref, tipBefore)
    registerTaskOnBranch(branch, ref, baseOf(target))
    return {
        ...outcome,
        merged: true,
        alreadyMerged: forwarded.alreadyMerged,
    }
}

/**
 * Where the task's own commits start: the commit `tasks branch` cut it from,
 * when that was recorded and is still in its history, otherwise its fork point
 * from the base and the work package's other branches. Null when neither can
 * be found, which leaves the plain rebase as the only option.
 */
export function ownCommitsStart(
    ref: string,
    taskBranch: string,
    target: WorkPackageBranch,
): string | null {
    const recorded = branchedFrom(ref)
    if (recorded && refExists(recorded) && isAncestor(recorded, taskBranch))
        return recorded
    return forkPointOf(taskBranch, target)
}

function mergeIntoSecondary(
    ref: string,
    taskBranch: string,
    target: WorkPackageBranch,
): TargetMergeOutcome {
    const { branch, created } = ensureWorkPackageBranch(target)
    const outcome = outcomeFor(target, created)
    const start =
        ownCommitsFrom(ref) ??
        (targetBranchesOf(requireTask(ref)).some(
            (one) =>
                one.id !== target.id &&
                branchExists(one.branchName) &&
                isAncestor(taskBranch, one.branchName),
        )
            ? null
            : forkPointOf(taskBranch, target))

    if (
        isAncestor(taskBranch, branch) ||
        (start && patchesApplied(branch, taskBranch, start))
    ) {
        registerTaskOnBranch(branch, ref, baseOf(target))
        return { ...outcome, merged: true, alreadyMerged: true }
    }
    if (!start) {
        return {
            ...outcome,
            conflict:
                `${ref} was merged into its first branch before this tool recorded where its own ` +
                `commits start, so they cannot be picked out for '${branch}'. Cherry-pick them onto ` +
                `'${branch}' by hand, then run 'tasks merge ${ref}' to register it.`,
        }
    }

    const replayed = replayRange(start, taskBranch, branch)
    if (!replayed.rebased) return { ...outcome, conflict: replayed.conflict }
    registerTaskOnBranch(branch, ref, baseOf(target))
    return { ...outcome, merged: true }
}

/**
 * Where a task branch that has not been merged anywhere was cut from, as far
 * as its commits go: the newest of its fork points from the base and from the
 * work package's other branches. A task cut from a branch that already carried
 * other tasks starts after them, so their commits are not counted as its own.
 */
function forkPointOf(
    taskBranch: string,
    target: WorkPackageBranch,
): string | null {
    const points = [
        baseOf(target),
        ...listWorkPackageBranches(target.workPackageRef)
            .filter(
                (one) =>
                    one.id !== target.id &&
                    branchExists(one.branchName) &&
                    !isAncestor(taskBranch, one.branchName),
            )
            .map((one) => one.branchName),
    ]
        .filter((point) => refExists(point))
        .map((point) => mergeBase(point, taskBranch))
        .filter((sha): sha is string => sha !== null)
    return (
        points.find((sha) => points.every((other) => isAncestor(other, sha))) ??
        points[0] ??
        null
    )
}

const FINISHED = new Set(["dev_complete", "verified", "closed"])

/**
 * Make the Git branch carry what its task list says, after that list changed
 * from `before`.
 *
 * A task that is still being worked needs nothing: it is merged in when it is
 * done. A finished one added to the list is merged now, the same way `tasks
 * done` would have. A task taken off the list has its commits dropped and the
 * branch rebuilt from the rest, which rewrites it — so the next push of a
 * branch that has been pushed already has to force.
 */
export function syncBranchTasks(
    branch: WorkPackageBranch,
    before: string[],
): BranchTaskSync {
    const result: BranchTaskSync = {
        merged: [],
        removed: [],
        problems: [],
        failed: [],
    }
    const had = new Set(before.map((ref) => ref.toLowerCase()))
    const has = new Set(branch.taskRefs.map((ref) => ref.toLowerCase()))
    const usable = (ref: string) => {
        const task = requireTask(ref)
        return task.useGitWorkflow &&
            task.branchName &&
            branchExists(task.branchName)
            ? task
            : null
    }

    const adding: Task[] = []
    for (const ref of branch.taskRefs) {
        if (had.has(ref.toLowerCase())) continue
        const task = usable(ref)
        if (!task || !FINISHED.has(task.status)) continue
        // Already on it — an adopted branch, or a merge done by hand.
        if (
            branchExists(branch.branchName) &&
            isAncestor(task.branchName!, branch.branchName)
        ) {
            registerTaskOnBranch(branch.branchName, task.ref, baseOf(branch))
            continue
        }
        adding.push(task)
    }

    // Which commits each removed task has on the branch, found by patch id so
    // a copy made by a secondary merge is recognised as well as the original.
    const name = branch.branchName
    const fork = branchExists(name) ? mergeBase(baseOf(branch), name) : null
    const range = fork ? `${fork}..${name}` : null
    const onBranch = range ? patchIds(range) : new Map<string, string>()
    const removing: { ref: string; commits: string[] }[] = []
    for (const ref of before.filter((one) => !has.has(one.toLowerCase()))) {
        const task = usable(ref)
        if (!task || !onBranch.size) continue
        const start =
            ownCommitsFrom(task.ref) ?? forkPointOf(task.branchName!, branch)
        if (!start) continue
        if (!ownCommitsFrom(task.ref) && isAncestor(task.branchName!, name)) {
            result.problems.push(
                `${task.ref} was put on '${name}' by hand, so which of its commits are its own is not recorded. Drop them from the branch by hand.`,
            )
            continue
        }
        const commits = [...patchIds(`${start}..${task.branchName}`).keys()]
            .map((id) => onBranch.get(id))
            .filter((sha): sha is string => !!sha)
        if (commits.length) removing.push({ ref: task.ref, commits })
    }

    if (!adding.length && !removing.length) return result

    const blocked = mergeInProgress()
        ? `A merge is in progress on '${currentBranch() ?? "HEAD"}'.`
        : rebaseInProgress()
          ? `A rebase is in progress on '${currentBranch() ?? "HEAD"}'.`
          : !workingTreeClean()
            ? "The working tree has uncommitted changes."
            : null
    if (blocked) {
        result.problems.push(
            `${blocked} The task list is saved, but '${name}' was not changed — save it again once that is sorted out.`,
        )
        result.failed.push(...adding.map((task) => task.ref))
        return result
    }

    const from = currentBranch()
    try {
        if (removing.length && range && fork) {
            if (hasMerges(range)) {
                result.problems.push(
                    `'${name}' has merge commits, so ${removing.map((one) => one.ref).join(", ")} cannot be taken off it here. Drop their commits by hand.`,
                )
            } else {
                const commits = commitsIn(range)
                const drop = new Set(removing.flatMap((one) => one.commits))
                const rebuilt = rebuildBranch(name, fork, commits, drop)
                if (!rebuilt.rebuilt) {
                    result.problems.push(
                        `Taking ${removing.map((one) => one.ref).join(", ")} off '${name}' collides with the commits left on it. Nothing was changed.\n${rebuilt.conflict}`,
                    )
                } else {
                    for (const one of removing) {
                        unregisterTaskFromBranch(name, one.ref)
                        result.removed.push(one.ref)
                    }
                    followRebuild(branch, rebuilt.mapping)
                }
            }
        }

        for (const task of adding) {
            const outcome =
                primaryTargetOf(task)?.id === branch.id &&
                !isPushed(task.branchName!)
                    ? mergeIntoPrimary(task.ref, task.branchName!, branch)
                    : mergeIntoSecondary(task.ref, task.branchName!, branch)
            if (outcome.merged) result.merged.push(task.ref)
            else {
                result.failed.push(task.ref)
                result.problems.push(
                    `${task.ref}'s commits could not be put on '${name}'. Nothing was changed for it.\n${outcome.conflict}`,
                )
            }
        }
    } finally {
        if (from && currentBranch() !== from) switchBranch(from)
    }
    return result
}

/**
 * After a rebuild, point the tasks whose first branch this is at the copies of
 * their commits, so they still read as merged into it, and keep the recorded
 * start of their own commits on the branch they now sit on.
 */
function followRebuild(
    branch: WorkPackageBranch,
    mapping: Map<string, string>,
): void {
    for (const ref of branch.taskRefs) {
        const task = requireTask(ref)
        if (primaryTargetOf(task)?.id !== branch.id) continue
        const start = ownCommitsFrom(task.ref)
        if (start && mapping.has(start))
            recordOwnCommitsFrom(task.ref, mapping.get(start)!)
        if (!task.branchName || isPushed(task.branchName)) continue
        const tip = resolveCommit(task.branchName)
        const moved = tip ? mapping.get(tip) : undefined
        if (!moved || moved === tip) continue
        try {
            moveBranch(task.branchName, moved)
        } catch {
            // Checked out in another worktree. The branch is still right; the
            // task only reads as missing from it until it is merged again.
        }
    }
}

export interface BaseRebaseResult {
    /** The branch now sits on its base's tip. False on a conflict. */
    rebased: boolean
    /** It already did, so nothing moved. */
    upToDate: boolean
    /** The branch has a remote counterpart, so the next push must force. */
    pushed: boolean
    /** Set when the rebase collided. It has been aborted: nothing moved. */
    conflict: GitConflict | null
}

/**
 * Replay a work package branch onto the current tip of its base.
 *
 * The base is brought up to date with `origin` first, the same way a delivery
 * branch is before it is cut, so "rebase on master" means the master everyone
 * else sees. A conflict aborts, like every other rebase here, and comes back as
 * a `GitConflict` for the caller to hand to an agent or to a person.
 *
 * Unlike a task merge, a branch that has been pushed is not refused: this is a
 * deliberate request to rewrite it. It is only reported, since the next push
 * then has to force.
 */
export function rebaseBranchOnBase(
    branch: WorkPackageBranch,
): BaseRebaseResult {
    const name = branch.branchName
    const base = baseOf(branch)
    if (!branchExists(name))
        throw new Error(
            `'${name}' does not exist locally, so there is nothing to rebase.`,
        )
    if (mergeInProgress()) {
        throw new Error(
            `A merge is already in progress on '${currentBranch() ?? "HEAD"}'. Resolve and commit it (or 'git merge --abort') first.`,
        )
    }
    if (rebaseInProgress()) {
        throw new Error(
            `A rebase is already in progress on '${currentBranch() ?? "HEAD"}'. Finish it ('git rebase --continue') or cancel it ('git rebase --abort') first.`,
        )
    }
    if (!workingTreeClean()) {
        throw new Error(
            `The working tree must be clean before rebasing '${name}' onto '${base}'. Commit or stash first.`,
        )
    }

    refreshBaseBranch(base)
    const pushed = isPushed(name)
    if (isAncestor(base, name))
        return { rebased: true, upToDate: true, pushed, conflict: null }

    const from = currentBranch()
    try {
        const replayed = rebaseOnto(name, base)
        if (replayed.rebased)
            return { rebased: true, upToDate: false, pushed, conflict: null }
        return {
            rebased: false,
            upToDate: false,
            pushed,
            conflict: {
                operation: "rebase",
                scope: "repo",
                branch: name,
                onto: base,
                files: replayed.files,
                detail: replayed.conflict,
            },
        }
    } finally {
        if (from && currentBranch() !== from) switchBranch(from)
    }
}

/**
 * The target branches a finished task's work is missing from.
 *
 * Answered from Git for the first target, because the record is written by the
 * merge that may not have happened: ancestry holds precisely because that merge
 * is a rebase and fast-forward. Later targets hold a *copy*, so ancestry cannot
 * see them, and the delivery record is what says they landed.
 */
export function missingTargets(task: Task): WorkPackageBranch[] {
    if (!task.useGitWorkflow || !task.branchName) return targetBranchesOf(task)
    return targetBranchesOf(task).filter((target, index) => {
        if (!branchExists(target.branchName)) return true
        if (index === 0) return !isAncestor(task.branchName!, target.branchName)
        const record = findCombinedBranch(target.branchName)
        return !record?.taskRefs.some(
            (one) => one.toLowerCase() === task.ref.toLowerCase(),
        )
    })
}

/**
 * One branch as the work package page draws it: the record plus its live Git
 * state. Read fresh, like every other branch view — a branch can be advanced,
 * pushed or deleted from a terminal at any time. A branch not created yet reads
 * as `exists: false` rather than as an error.
 */
export function workPackageBranchDetail(
    branch: WorkPackageBranch,
): WorkPackageBranchDetail {
    const base = baseOf(branch)
    const git = readBranch(branch.branchName, base)
    let delivery = findCombinedBranch(branch.branchName)
    // An existing branch attached to a work package is already a delivery branch in
    // practice. Initialise its metadata as soon as Git shows that it carries
    // work, rather than waiting for a task merge that may never happen.
    if (!delivery && git.exists && git.commits.length > 0) {
        delivery = recordCombine({
            branchName: branch.branchName,
            baseBranch: base,
            taskRefs: [],
        })
    }
    return {
        ...branch,
        base,
        git,
        delivery,
        rebaseSupervision: rebaseSupervision(branch.branchName),
    }
}

/**
 * Everything the work package page draws, assembled in one read.
 */
export function getWorkPackageDetail(refOrName: string): WorkPackageDetail {
    const workPackage = requireWorkPackage(refOrName)
    // The summary carries the counts, and it is the same object the list draws
    // from — so the page and the sidebar can never disagree about them.
    const summary = listWorkPackages().find(
        (one) => one.ref === workPackage.ref,
    )!
    const tasks = listTasks({
        workPackageRef: workPackage.ref,
        includeClosed: true,
    })

    // What is left to do, in an order that can actually be worked. Dev complete
    // and verified tasks are done being written, so they are not in the queue
    // even though they are still in the work package.
    const queue = dependencyOrder(
        tasks.filter(
            (task) =>
                task.status === "backlog" || task.status === "in_progress",
        ),
    )

    // Closed tasks included deliberately: a blocker that is finished has to be
    // *found* to be recognised as satisfied. Leaving it out would make it look
    // like a ref nothing knows about, which is skipped rather than cleared.
    const universe = listTasks({ includeClosed: true })
    const own = new Set(tasks.map((task) => task.ref.toLowerCase()))
    const outside = new Map<string, Task>()
    for (const task of queue) {
        for (const blocker of unmetDependencies(task, universe)) {
            if (!own.has(blocker.ref.toLowerCase()))
                outside.set(blocker.ref, blocker)
        }
    }

    return {
        ...summary,
        tasks,
        investigations: listInvestigations({
            workPackageRef: workPackage.ref,
        }).sort((left, right) => left.id - right.id),
        branches: listWorkPackageBranches(workPackage.ref).map(
            workPackageBranchDetail,
        ),
        queue,
        outsideBlockers: [...outside.values()],
        // Workspace-wide, not work package-scoped: a task in flight anywhere is what stops
        // the next one starting, and `universe` is already to hand.
        inProgress: universe.filter((task) => task.status === "in_progress"),
        baseBranch: defaultBaseBranch(),
        // Read here rather than fetched alongside: a loop in flight changes what
        // every button on the work package page is allowed to offer, so it has to arrive
        // with the queue it is working, not a request later.
        run: latestWorkPackageRun(workPackage.ref),
        workRuns: listWorkRuns(workPackage.ref).map(workRunDetail),
    }
}
