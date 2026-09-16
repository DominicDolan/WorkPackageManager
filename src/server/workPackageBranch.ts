import {
  branchExists,
  createBranch,
  currentBranch,
  defaultBaseBranch,
  fastForward,
  isAncestor,
  isPushed,
  mergeInProgress,
  rebaseInProgress,
  rebaseOnto,
  readBranch,
  refExists,
  switchBranch,
  workingTreeClean,
} from "./branches"
import {
  findCombinedBranch,
  findWorkPackage,
  latestWorkPackageRun,
  listWorkPackages,
  listTasks,
  recordCombine,
  registerTaskOnBranch,
  requireWorkPackage,
  requireTask,
} from "./repo"
import {
  dependencyOrder,
  unmetDependencies,
  type Task,
  type WorkPackage,
  type WorkPackageDetail,
} from "../shared/types"
import { linkedNotes } from "./noteLinks"

/**
 * A work package's branch as an integration branch.
 *
 * A work package is a piece of work made of several tasks, and its branch is where
 * that work adds up: every member is cut from it rather than from master, and
 * `tasks done` merges each member back into it. What the work package's PR contains is
 * then exactly its finished tasks, and nothing else has to be selected by hand.
 *
 * Every merge also registers the task on the branch's delivery record, so the
 * Branches view can answer "what is on this branch" from the database rather
 * than from Git archaeology.
 */

export interface ResolvedWorkPackageBranch {
  workPackage: WorkPackage
  branch: string
}

/** The work package branch a task belongs to, or null when the task is loose. A work package
 *  ref pointing at a deleted work package reads as loose rather than failing: the task
 *  is still perfectly workable. */
export function workPackageBranchOf(
  task: Task,
): ResolvedWorkPackageBranch | null {
  if (!task.workPackageRef) return null
  const workPackage = findWorkPackage(task.workPackageRef)
  if (!workPackage?.branchName) return null
  return { workPackage, branch: workPackage.branchName }
}

/**
 * The work package's branch, created from the base branch if Git does not have it yet.
 *
 * Creating it lazily is what keeps a work package cheap: filing tasks under a heading
 * should not put a branch in the repository, and the first task to actually be
 * worked is the moment one is needed. It is created without being checked out,
 * so this never moves the user off what they are on.
 */
export function ensureWorkPackageBranch(workPackage: WorkPackage): {
  branch: string
  created: boolean
} {
  const branch = workPackage.branchName
  if (!branch)
    throw new Error(
      `${workPackage.ref} (${workPackage.name}) has no branch assigned.`,
    )
  if (branchExists(branch)) return { branch, created: false }

  const base = defaultBaseBranch()
  // `origin/<base>` covers a fresh clone where the base has never been checked
  // out locally — `refExists` resolves either form.
  const start = branchExists(base) ? base : `origin/${base}`
  if (!refExists(start)) {
    throw new Error(
      `Cannot create ${workPackage.ref}'s branch '${branch}': the base branch '${base}' exists neither locally nor on origin.`,
    )
  }

  createBranch(branch, start)
  return { branch, created: true }
}

export interface WorkPackageMergeResult {
  /** Null when the task is in no work package, or its work package has no branch — the caller
   *  reports that as "nothing to merge into", not as a failure. */
  workPackage: WorkPackage | null
  branch: string
  /** The task's own branch — named in the conflict message, since resolving one
   *  by hand means rebasing that branch specifically. */
  taskBranch: string
  /** True when the work package branch had to be created for this merge. */
  createdBranch: boolean
  /** The task's work is on the work package branch, either just now or already. */
  merged: boolean
  alreadyMerged: boolean
  /** Set when the task's commits could not be replayed onto the work package branch.
   *  Nothing is left half-done: the rebase is aborted and both branches are
   *  exactly as they were. */
  conflict: string
  /** Where the caller was before, and is again — including after a conflict,
   *  which no longer strands anyone mid-operation. */
  returnedTo: string | null
}

/**
 * Put a task's commits on its work package's branch and register it there.
 *
 * Two steps, and the first is what keeps the branch readable: the task's commits
 * are replayed onto the work package branch's tip, and then the work package branch is
 * fast-forwarded to them. No merge commit, so the work package branch ends up a plain
 * list of the commits its tasks produced, in the order they were finished —
 * which is what somebody reviewing the work package's PR wants to read.
 *
 * The task keeps whatever commits it made rather than being squashed into one.
 * A task is sometimes several steps, and sometimes has something added to it by
 * hand, and flattening that loses a distinction the author meant to make.
 *
 * Rebasing rewrites the task branch, so a branch that has been pushed is
 * refused rather than quietly requiring a force-push afterwards.
 *
 * A collision aborts and changes nothing — see `rebaseOnto`. Once the user has
 * rebased and resolved it themselves, running this again finds the task branch
 * already sitting on the work package branch and simply registers it.
 */
export function mergeTaskIntoWorkPackageBranch(
  ref: string,
): WorkPackageMergeResult {
  const task = requireTask(ref)
  const resolved = workPackageBranchOf(task)
  if (!resolved) {
    return {
      workPackage: null,
      branch: "",
      taskBranch: task.branchName ?? "",
      createdBranch: false,
      merged: false,
      alreadyMerged: false,
      conflict: "",
      returnedTo: null,
    }
  }

  const { workPackage } = resolved
  if (!task.branchName)
    throw new Error(
      `${task.ref} has no assigned branch, so there is nothing to merge.`,
    )
  if (!branchExists(task.branchName)) {
    throw new Error(
      `${task.ref}'s branch '${task.branchName}' does not exist locally, so there is nothing to merge.`,
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
      `The working tree must be clean before merging ${task.ref} into '${workPackage.branchName}'. Commit or stash first, or pass --no-merge.`,
    )
  }

  const from = currentBranch()
  const { branch, created } = ensureWorkPackageBranch(workPackage)

  // Already contained: nothing to merge, but the registration may still be
  // missing — a conflict resolved by hand ends up exactly here.
  if (isAncestor(task.branchName, branch)) {
    registerTaskOnBranch(branch, task.ref, defaultBaseBranch())
    return {
      workPackage,
      branch,
      taskBranch: task.branchName,
      createdBranch: created,
      merged: true,
      alreadyMerged: true,
      conflict: "",
      returnedTo: from,
    }
  }

  // Rewriting a branch somebody else may have fetched is not this tool's call
  // to make, and it is not recoverable by them noticing later.
  if (isPushed(task.branchName)) {
    throw new Error(
      `${task.ref}'s branch '${task.branchName}' has been pushed, so replaying it onto ` +
        `'${branch}' would need a force-push afterwards. Merge it by hand, or delete the ` +
        "remote branch first if nothing depends on it.",
    )
  }

  // Replay first, fast-forward second. The rebase is what makes the work package branch
  // a straight list rather than a chain of merge commits.
  const replayed = rebaseOnto(task.branchName, branch)
  if (!replayed.rebased) {
    // Aborted, so nothing moved — but the rebase checked the task branch out on
    // its way, and the caller should end up where they started.
    if (from && currentBranch() !== from) switchBranch(from)
    return {
      workPackage,
      branch,
      taskBranch: task.branchName,
      createdBranch: created,
      merged: false,
      alreadyMerged: false,
      conflict: replayed.conflict,
      returnedTo: from,
    }
  }

  switchBranch(branch)
  const outcome = fastForward(task.branchName)

  if (!outcome.merged) {
    if (from && from !== branch) switchBranch(from)
    return {
      workPackage,
      branch,
      taskBranch: task.branchName,
      createdBranch: created,
      merged: false,
      alreadyMerged: false,
      conflict: outcome.conflict,
      returnedTo: from,
    }
  }

  registerTaskOnBranch(branch, task.ref, defaultBaseBranch())
  if (from && from !== branch) switchBranch(from)

  return {
    workPackage,
    branch,
    taskBranch: task.branchName,
    createdBranch: created,
    merged: true,
    alreadyMerged: outcome.alreadyMerged,
    conflict: "",
    returnedTo: from && from !== branch ? from : branch,
  }
}

/**
 * Everything the work package page draws, assembled in one read.
 *
 * The Git state is read live, like every other branch view: a work package branch can
 * be advanced, pushed or deleted from a terminal at any time, and a page that
 * cached it would be quietly wrong. A work package whose branch has not been created
 * yet reads as `exists: false` rather than as an error — that is the normal
 * state of a work package nobody has started.
 */
export function getWorkPackageDetail(refOrName: string): WorkPackageDetail {
  const workPackage = requireWorkPackage(refOrName)
  // The summary carries the counts, and it is the same object the list draws
  // from — so the page and the sidebar can never disagree about them.
  const summary = listWorkPackages().find((one) => one.ref === workPackage.ref)!
  const tasks = listTasks({
    workPackageRef: workPackage.ref,
    includeClosed: true,
  })
  const base = defaultBaseBranch()

  // What is left to do, in an order that can actually be worked. Dev complete
  // and verified tasks are done being written, so they are not in the queue
  // even though they are still in the work package.
  const queue = dependencyOrder(
    tasks.filter(
      (task) => task.status === "backlog" || task.status === "in_progress",
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
      if (!own.has(blocker.ref.toLowerCase())) outside.set(blocker.ref, blocker)
    }
  }

  const git = readBranch(workPackage.branchName, base)
  let delivery = findCombinedBranch(workPackage.branchName)
  // An existing branch attached to a work package is already a delivery branch in
  // practice. Initialise its metadata as soon as Git shows that it carries
  // work, rather than waiting for a task merge that may never happen.
  if (!delivery && git.exists && git.commits.length > 0) {
    delivery = recordCombine({
      branchName: workPackage.branchName,
      baseBranch: base,
      taskRefs: [],
    })
  }

  return {
    ...summary,
    tasks,
    notes: linkedNotes("work-package", workPackage.ref),
    queue,
    outsideBlockers: [...outside.values()],
    // Workspace-wide, not work package-scoped: a task in flight anywhere is what stops
    // the next one starting, and `universe` is already to hand.
    inProgress: universe.filter((task) => task.status === "in_progress"),
    baseBranch: base,
    git,
    delivery,
    // Read here rather than fetched alongside: a loop in flight changes what
    // every button on the work package page is allowed to offer, so it has to arrive
    // with the queue it is working, not a request later.
    run: latestWorkPackageRun(workPackage.ref),
  }
}
