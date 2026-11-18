import { existsSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { workspace } from "./config/paths"
import {
    captureBefore,
    checkpointDir,
    checkpointExists,
    checkpointNameOf,
    type CheckpointOptions,
    type CheckpointResult,
} from "./aiovr"
import {
    branchExists,
    currentBranch,
    defaultBaseBranch,
    describeCommit,
    detachAt,
    headCommit,
    mergeBase,
    mergeInProgress,
    rebaseInProgress,
    switchBranch,
    trackedChanges,
    type CommitSummary,
} from "./branches"
import { firstRun } from "./repo"
import type { Task } from "@work-task-manager/shared"

/**
 * Capturing a `before` checkpoint after the fact.
 *
 * The normal order is capture, change, compare. Sometimes the change is already
 * written — or the scenario that would have shown it was only written later —
 * and the starting state was never recorded. Since the scenarios live outside
 * Git (`.aio-vr/` is ignored), the state can still be captured: check out the
 * commit the work started from, run *today's* scenarios against that old code,
 * then come back. New and edited scenarios are included, which is the point.
 *
 * What this cannot do is rebuild anything for you. Whatever serves the app under
 * test — a dev server, a container — has to pick the old code up before the
 * scenarios run against it, hence `settleSeconds`.
 */

/** Where the commit to travel to came from, so the user can see the reasoning. */
export type RetroSource = "flag" | "first-before" | "fork-point"

export interface RetroTarget {
    commit: CommitSummary
    source: RetroSource
    /** Prose for the source, ready to print. */
    reason: string
    /** True when the original capture was taken over a dirty tree, so the commit
     *  alone does not reproduce exactly what was on screen. */
    wasDirty: boolean
}

export interface RetroOptions extends CheckpointOptions {
    /** Seconds to wait after checking the old commit out, before capturing. */
    settleSeconds?: number
    /** Called at each step, so a CLI can narrate a slow operation. */
    onStep?: (message: string) => void
}

export interface RetroResult extends CheckpointResult {
    target: RetroTarget
    /** The branch (or detached commit) the working tree was put back on. */
    restoredTo: string
}

/**
 * Which commit a retroactive capture should be taken at.
 *
 * `at` wins when given. Otherwise the first `before` run recorded for the task
 * says where its starting state was — re-capturing has to stand at the same
 * place as the capture it replaces, or the comparison changes meaning. With no
 * run at all there is nothing recorded, so the branch's fork point from the base
 * branch is the best available answer: the commit the work was cut from.
 */
export function resolveRetroTarget(task: Task, at?: string): RetroTarget {
    if (at) {
        const commit = describeCommit(at)
        if (!commit)
            throw new Error(
                `'${at}' does not name a commit in this repository.`,
            )
        return { commit, source: "flag", reason: `--at ${at}`, wasDirty: false }
    }

    const recorded = firstRun(task.id, "before")
    if (recorded?.gitHead) {
        const commit = describeCommit(recorded.gitHead)
        if (!commit) {
            throw new Error(
                `The first 'before' capture for ${task.ref} was taken at ${recorded.gitHead.slice(0, 12)}, which is no longer in this repository — it was rewritten or pruned. Pass --at <commit> to say where to capture from.`,
            )
        }
        return {
            commit,
            source: "first-before",
            reason: `the commit the first 'before' capture was taken at`,
            wasDirty: recorded.gitDirty === 1,
        }
    }

    if (!task.branchName) {
        throw new Error(
            `${task.ref} has no 'before' capture and no assigned branch, so there is nothing to say where its work started. Pass --at <commit>.`,
        )
    }
    if (!branchExists(task.branchName)) {
        throw new Error(
            `${task.ref} is assigned to '${task.branchName}', which does not exist locally. Pass --at <commit>.`,
        )
    }

    const base = defaultBaseBranch()
    const fork = mergeBase(base, task.branchName)
    if (!fork) {
        throw new Error(
            `Could not find a common ancestor between '${base}' and '${task.branchName}'. Pass --at <commit>.`,
        )
    }
    const commit = describeCommit(fork)
    if (!commit) throw new Error(`Could not read commit ${fork}.`)

    return {
        commit,
        source: "fork-point",
        reason: `where '${task.branchName}' was cut from '${base}'`,
        wasDirty: false,
    }
}

/** Refuse to move the working tree when moving it would lose or break something. */
function assertSafeToTimeTravel(): void {
    if (mergeInProgress())
        throw new Error(
            "A merge is in progress. Finish or abort it before capturing retroactively.",
        )
    if (rebaseInProgress())
        throw new Error(
            "A rebase is in progress. Finish or abort it before capturing retroactively.",
        )

    const changes = trackedChanges()
    if (changes.length) {
        throw new Error(
            [
                "The working tree has uncommitted changes, and capturing retroactively checks out an older commit.",
                "Commit or stash them first:",
                ...changes.slice(0, 10).map((line) => `  ${line}`),
                changes.length > 10
                    ? `  ...and ${changes.length - 10} more`
                    : "",
            ]
                .filter(Boolean)
                .join("\n"),
        )
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Check out the commit the task started from, capture `before` there with the
 * scenarios as they exist today, and put the working tree back.
 *
 * The restore runs in a `finally`, so an aio-vr failure — or a scenario that
 * throws half way through the suite — still leaves the user where they were.
 */
export async function captureBeforeRetro(
    task: Task,
    target: RetroTarget,
    options: RetroOptions = {},
): Promise<RetroResult> {
    const step = options.onStep ?? (() => {})

    assertSafeToTimeTravel()

    // Where to come back to. A branch is restored by name so the working tree ends
    // up attached again; a detached HEAD is restored to the same commit.
    const branch = currentBranch()
    const head = headCommit()
    if (!branch && !head)
        throw new Error(
            "Could not read the current HEAD, so there would be no way back.",
        )
    const restorePoint = branch ?? head!

    if (head === target.commit.sha) {
        // Nothing to travel to: capture where we already are rather than detaching
        // and re-attaching for no reason.
        step(
            `Already at ${target.commit.shortSha}; capturing without checking anything out.`,
        )
        const result = await captureBefore(task, options)
        return { ...result, target, restoredTo: restorePoint }
    }

    const backup = await stashCheckpoint(task)

    try {
        step(
            `Checking out ${target.commit.shortSha} (${target.commit.subject})`,
        )
        detachAt(target.commit.sha)

        if (options.settleSeconds) {
            step(
                `Waiting ${options.settleSeconds}s for the app to pick the old code up...`,
            )
            await sleep(options.settleSeconds * 1000)
        }

        step("Capturing the before state...")
        const result = await captureBefore(task, options)

        if (backup) await rm(backup, { force: true, recursive: true })
        return { ...result, target, restoredTo: restorePoint }
    } catch (error) {
        await restoreCheckpoint(task, backup)
        throw error
    } finally {
        step(
            `Restoring ${restorePoint === branch ? `branch '${restorePoint}'` : restorePoint.slice(0, 12)}`,
        )
        if (branch) switchBranch(branch)
        else detachAt(restorePoint)
    }
}

/**
 * Move an existing checkpoint aside before re-capturing over it.
 *
 * `aio-vr before` deletes the checkpoint it is about to write, so a capture that
 * fails half way would otherwise destroy evidence that was already there — the
 * one thing a retroactive capture must not do, since it is usually run precisely
 * because that evidence matters.
 */
async function stashCheckpoint(task: Task): Promise<string | null> {
    const name = checkpointNameOf(task)
    if (!checkpointExists(name)) return null

    const backup = join(
        workspace().aioVrDir,
        "checkpoints",
        `${name}.retro-backup`,
    )
    await rm(backup, { force: true, recursive: true })
    await rename(checkpointDir(name), backup)
    return backup
}

/** Put a stashed checkpoint back, unless the failed run left a usable one. */
async function restoreCheckpoint(
    task: Task,
    backup: string | null,
): Promise<void> {
    if (!backup || !existsSync(backup)) return

    const name = checkpointNameOf(task)
    if (checkpointExists(name)) {
        // The capture wrote a complete checkpoint and something later went wrong.
        // The new one is the better record; drop the copy.
        await rm(backup, { force: true, recursive: true })
        return
    }

    await rm(checkpointDir(name), { force: true, recursive: true })
    await rename(backup, checkpointDir(name))
}
