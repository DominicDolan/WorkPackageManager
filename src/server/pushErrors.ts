/**
 * Turn `git push` stderr into a message a person can act on.
 *
 * Git's own output for a rejected push is accurate but opaque ("! [rejected] …
 * (fetch first)"), and the UI only shows the first line of it. The common
 * cause is that someone else has pushed to the same remote branch since this
 * branch was last pushed, so the remote has commits the local branch lacks.
 */
export function describePushFailure(input: {
    stderr: string
    branch: string
    remoteBranch: string
    force: boolean
}): string {
    const { stderr, branch, remoteBranch, force } = input
    const target = `origin/${remoteBranch}`

    // --force-with-lease refuses when the remote moved since our last fetch.
    if (/stale info/i.test(stderr)) {
        return (
            `Could not force-push '${branch}': ${target} changed on the remote ` +
            "after this copy last fetched it, so the push was stopped to protect " +
            "those commits. Fetch the branch and review what was pushed before forcing again."
        )
    }

    // A plain push refused because the remote has commits we do not have.
    if (
        /non-fast-forward|\(fetch first\)|fetch first|Updates were rejected/i.test(
            stderr,
        )
    ) {
        if (force) {
            return (
                `Could not push '${branch}': ${target} has commits that this branch ` +
                "does not have, and the force push was refused. Fetch the branch and review those commits first."
            )
        }
        return (
            `Could not push '${branch}': ${target} has commits that this branch ` +
            "does not have, so the push would overwrite them. Someone else has probably " +
            "pushed to this branch. Fetch it and merge or rebase those commits into " +
            "this branch, or push to a different remote branch name."
        )
    }

    if (
        /Permission to .* denied|Authentication failed|could not read Username/i.test(
            stderr,
        )
    ) {
        return `Could not push '${branch}': GitHub rejected the credentials for ${target}. Check your git login for this repository.`
    }

    const detail = stderr.trim()
    return detail || `Could not push '${branch}'.`
}
