import { branchExists, createPullRequest, defaultBaseBranch } from "./branches"
import { checksBlockingPr } from "./checks"
import {
    addNote,
    findTask,
    requireCombinedBranch,
    updateCombinedBranch,
} from "./repo"

/**
 * Open a delivery branch's pull request from its saved title and body,
 * pushing first when it has no upstream, and note the PR on every task it
 * carries.
 *
 * Refused while the checks gate it, unless `force`: a check can be broken on
 * master, or irrelevant to a docs-only branch, and a tool that cannot be
 * overridden gets worked around instead of used.
 */
export async function openPullRequest(
    name: string,
    input: { draft?: boolean; force?: boolean } = {},
): Promise<{ url: string; pushed: boolean }> {
    const branch = requireCombinedBranch(name)

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

    updateCombinedBranch(name, {
        prUrl: result.url,
        prNumber: result.number,
    })
    for (const ref of branch.taskRefs) {
        if (findTask(ref)) addNote(ref, `Pull request opened: ${result.url}`)
    }
    return { url: result.url, pushed: result.pushed }
}
