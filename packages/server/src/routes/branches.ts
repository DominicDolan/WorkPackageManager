import {
    currentBranch,
    defaultBaseBranch,
    generatePrDescription,
    listLocalBranches,
    pushBranch,
} from "@work-task-manager/core/branches"
import { checksProgress } from "@work-task-manager/core/checks"
import {
    checksSupervision,
    stopSupervisedChecks,
} from "@work-task-manager/core/checksSupervisor"
import {
    branchDetail,
    editCombinedBranch,
    startBranchChecks,
    type CombinedBranchEdit,
} from "@work-task-manager/core/delivery"
import { openPullRequest } from "@work-task-manager/core/pullRequests"
import {
    deleteCombinedBranch,
    listCombinedBranches,
    requireCombinedBranch,
    updateCombinedBranch,
} from "@work-task-manager/core/repo"
import { fail } from "../http"
import { route } from "../router"
import { requireSupervisor, type SupervisorInput } from "./parse"

/**
 * Delivery branches. A branch name contains slashes, so it travels
 * percent-encoded as one segment: `/branches/feature%2Fx/push`.
 */
export const branchRoutes = [
    route(
        "GET",
        "/branches",
        "Every delivery branch with live Git state, plus the current and local branches.",
        () => ({
            branches: listCombinedBranches().map((branch) =>
                branchDetail(branch.branchName),
            ),
            currentBranch: currentBranch(),
            localBranches: listLocalBranches(),
            defaultBase: defaultBaseBranch(),
        }),
    ),

    route(
        "GET",
        "/branches/:name",
        "One delivery branch with live Git state, its tasks and its checks.",
        ({ params }) => ({
            branch: branchDetail(params.name!),
        }),
    ),

    route(
        "PATCH",
        "/branches/:name",
        "Rename a delivery branch, or set its PR target, remote branch, title or body.",
        async ({ params, body }) => {
            const saved = editCombinedBranch(
                params.name!,
                await body<CombinedBranchEdit>(),
            )
            return { branch: branchDetail(saved) }
        },
    ),

    // Forgets the branch here only; the Git branch and any PR are left alone.
    route(
        "DELETE",
        "/branches/:name",
        "Forget a delivery branch (Git and any PR are untouched).",
        ({ params }) => {
            deleteCombinedBranch(params.name!)
            return { deleted: params.name }
        },
    ),

    route(
        "GET",
        "/branches/:name/checks",
        "A branch's check results and whether a run is in progress. Cheap; poll this.",
        ({ params }) => {
            const branch = requireCombinedBranch(params.name!)
            return {
                checks: branch.checks,
                checksRunning: checksProgress(params.name!),
                checksSupervision: checksSupervision(params.name!),
            }
        },
    ),

    route(
        "POST",
        "/branches/:name/checks",
        "Run the configured pre-PR checks: all, one (check), from one (from), or what failed (resume).",
        async ({ params, bodyOr }) => {
            const name = params.name!
            requireCombinedBranch(name)
            const input = await bodyOr<{
                check?: unknown
                from?: unknown
                resume?: unknown
                supervisor?: SupervisorInput | null
            }>({})
            if (input.check !== undefined && typeof input.check !== "string")
                return fail("Unknown check.")
            if (input.from !== undefined && typeof input.from !== "string")
                return fail("Unknown starting check.")
            if (input.resume !== undefined && typeof input.resume !== "boolean")
                return fail("Resume must be a boolean.")
            startBranchChecks(name, {
                check: input.check as string | undefined,
                from: input.from as string | undefined,
                resume: input.resume as boolean | undefined,
                supervisor: requireSupervisor(input.supervisor),
            })
            return { branch: branchDetail(name) }
        },
    ),

    route(
        "DELETE",
        "/branches/:name/checks-supervisor",
        "Stop a supervised checks run.",
        ({ params }) => {
            stopSupervisedChecks(requireCombinedBranch(params.name!).branchName)
            return { branch: branchDetail(params.name!) }
        },
    ),

    // Persisted immediately: a generation takes real time and money, and losing
    // it to a closed tab would be the worst possible failure here.
    route(
        "POST",
        "/branches/:name/describe",
        "Write the PR title and body from the branch's commits with the PR agent.",
        async ({ params }) => {
            const name = params.name!
            const branch = requireCombinedBranch(name)
            const base = branch.baseBranch ?? defaultBaseBranch()
            const { title, body: prBody } = await generatePrDescription(
                branch.branchName,
                base,
            )
            updateCombinedBranch(name, {
                prTitle: title,
                prBody,
                baseBranch: base,
            })
            return { branch: branchDetail(name) }
        },
    ),

    route(
        "POST",
        "/branches/:name/push",
        "Push the branch to its remote (force optional).",
        async ({ params, bodyOr }) => {
            const input = await bodyOr<{ force?: boolean }>({})
            const branch = requireCombinedBranch(params.name!)
            await pushBranch({
                branch: branch.branchName,
                remoteBranch: branch.remoteBranch,
                force: input.force ?? false,
            })
            return { branch: branchDetail(params.name!) }
        },
    ),

    route(
        "POST",
        "/branches/:name/pr",
        "Push if needed, then open the pull request with gh.",
        async ({ params, bodyOr }) => {
            const input = await bodyOr<{ draft?: boolean; force?: boolean }>({})
            const result = await openPullRequest(params.name!, input)
            return { branch: branchDetail(params.name!), pushed: result.pushed }
        },
    ),
]
