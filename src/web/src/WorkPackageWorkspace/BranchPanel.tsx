import {
    checksSupervisionActive,
    type CombinedBranchDetail,
    type GitConflict,
    type RebaseSupervision,
    type RunSupervisor,
    type WorkPackageBranchDetail,
    type WorkPackageDetail,
} from "@shared/types"
import {
    action,
    createOptimistic,
    For,
    Show,
    createEffect,
    createSignal,
    deep,
    snapshot,
    type Element,
} from "solid-js"
import { api } from "../api"
import { createRecord } from "../hooks/createQuery"
import { ResumeSessionButton } from "../components/ResumeSessionButton"
import { SupervisorPickerDialog } from "../components/SupervisorPickerDialog"
import { useError } from "../hooks/useError"
import { renderMarkdown } from "../markdown"
import type { WorkspaceSnapshot } from "../types/workspace"
import { BranchCheckLauncher } from "./BranchCheckLauncher"
import { BranchChecks } from "./BranchChecks"
import { BranchTasks } from "./BranchTasks"
import { AgentOutput } from "../components/AgentOutput"
import { TabHeading } from "./TabHeading"

export function BranchPanel(props: {
    workPackage: WorkPackageDetail
    branch: WorkPackageBranchDetail
    /** The branch's delivery record, once it has one. */
    delivery?: CombinedBranchDetail
    tools: WorkspaceSnapshot["tools"]
    changed: () => void
    workPackageChanged: () => void
    /** A rebase stopped on conflicts; the workspace owns the resolution dialog. */
    conflicted: (conflict: GitConflict) => void
}) {
    // Reconciled, not replaced: the checks poll writes a fresh copy every few
    // seconds, and replacing it would rebuild every row beneath it.
    const [current, setCurrent] = createRecord<CombinedBranchDetail>()
    // Unsaved edits only. Until the field is touched it shows the saved value,
    // so nothing has to copy server data into it, and a refetch or the checks
    // poll replacing `current` cannot wipe what is being typed.
    const [branchNameDraft, setBranchName] = createSignal<string>()
    const [remoteBranchDraft, setRemoteBranch] = createSignal<string>()
    const branchName = () => branchNameDraft() ?? props.branch.branchName
    const remoteBranch = () =>
        remoteBranchDraft() ?? current()?.remoteBranch ?? ""
    const [title, setTitle] = createSignal("")
    const [body, setBody] = createSignal("")
    const [mode, setMode] = createSignal<"write" | "preview">("write")
    const [busy, setBusy] = createOptimistic("")
    const { capture, clear, Banner } = useError()
    const [notice, setNotice] = createSignal("")
    const [checkAgentOpen, setCheckAgentOpen] = createSignal(false)
    const [pickingRebaseSupervisor, setPickingRebaseSupervisor] =
        createSignal(false)
    const [stoppingRebase, setStoppingRebase] = createSignal(false)
    const rebaseSupervision = () => props.branch.rebaseSupervision
    const resolving = () => rebaseSupervision()?.status === "resolving"

    const applyBranch = (branch: CombinedBranchDetail, overwrite = true) => {
        const previous = current()
        if (overwrite || title() === (previous?.prTitle ?? ""))
            setTitle(branch.prTitle ?? "")
        if (overwrite || body() === (previous?.prBody ?? ""))
            setBody(branch.prBody ?? "")
        if (remoteBranchDraft()?.trim() === (branch.remoteBranch ?? ""))
            setRemoteBranch(undefined)
        setCurrent(branch)
    }
    createEffect(
        () => props.delivery && deep(props.delivery),
        (branch) => {
            if (branch && branch.updatedAt !== current()?.updatedAt)
                applyBranch(branch, false)
            if (!branch) setCurrent(undefined)
        },
    )

    const run = action(async function* (
        label: string,
        request: () => Promise<CombinedBranchDetail>,
        message: string,
    ) {
        if (busy()) return

        setBusy(label)
        clear()
        setNotice("")
        try {
            const branch = await request()
            yield
            applyBranch(branch)
            setNotice(message)
            props.changed()
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const generate = () => {
        const branch = current()
        if (branch)
            return run(
                "describe",
                () => api.describeBranch(branch.branchName),
                "Pull request description generated.",
            )
    }
    const save = () => {
        const branch = current()
        if (branch)
            return run(
                "save",
                () =>
                    api.updateBranch(branch.branchName, {
                        prTitle: title(),
                        prBody: body(),
                    }),
                "Pull request description saved.",
            )
    }
    const push = () => {
        const branch = current()
        if (branch)
            return run(
                "push",
                () => api.pushBranch(branch.branchName, branch.git.diverged),
                "New commits pushed to the pull request.",
            )
    }
    const openPr = action(async function* (draft: boolean, force = false) {
        if (busy()) return

        const branch = current()
        if (!branch) return
        setBusy(force ? "pr-force" : draft ? "pr-draft" : "pr")
        clear()
        setNotice("")
        try {
            let latest = branch
            if (descriptionDirty()) {
                latest = await api.updateBranch(branch.branchName, {
                    prTitle: title(),
                    prBody: body(),
                })
                yield
            }
            const result = await api.createPr(latest.branchName, draft, force)
            yield
            applyBranch(result.branch)
            const opened = draft
                ? "Draft pull request opened."
                : "Pull request opened."
            setNotice(
                result.pushed
                    ? `Branch pushed and ${opened.toLowerCase()}`
                    : opened,
            )
            props.changed()
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const saveBranchName = action(function* () {
        if (busy()) return

        const next = branchName().trim()
        if (!next || next === props.branch.branchName) return
        setBusy("branch-name")
        clear()
        setNotice("")
        try {
            yield api.updateWorkPackageBranch(
                props.workPackage.ref,
                props.branch.id,
                { branchName: next },
            )
            setBranchName(undefined)

            setNotice(
                props.branch.git.exists
                    ? "Local branch renamed with its commit history."
                    : "Delivery branch name updated.",
            )
            props.workPackageChanged()
        } catch (caught) {
            capture(caught)
        }
    })
    const rebasedNotice = (base: string, upToDate: boolean, pushed: boolean) =>
        upToDate
            ? `Already up to date with ${base}.`
            : `Rebased onto ${base}.${pushed ? " It was pushed before, so the next push has to force." : ""}`

    // Failures reach the dialog, which shows them where the choice was made.
    const rebaseWithSupervisor = async (supervisor: RunSupervisor) => {
        const base = props.branch.base
        clear()
        setNotice("")
        const result = await api.rebaseWorkPackageBranch(
            props.workPackage.ref,
            props.branch.id,
            supervisor,
        )
        if (!result.supervision)
            setNotice(rebasedNotice(base, result.upToDate, result.pushed))
        props.workPackageChanged()
    }

    const stopRebaseSupervisor = async () => {
        if (stoppingRebase()) return
        setStoppingRebase(true)
        clear()
        try {
            await api.stopRebaseSupervisor(
                props.workPackage.ref,
                props.branch.id,
            )
            props.workPackageChanged()
        } catch (caught) {
            capture(caught)
        } finally {
            setStoppingRebase(false)
        }
    }

    const rebase = action(async function* () {
        if (busy()) return

        const base = props.branch.base
        setBusy("rebase")
        clear()
        setNotice("")
        try {
            const result = await api.rebaseWorkPackageBranch(
                props.workPackage.ref,
                props.branch.id,
            )
            yield
            if (result.conflict) {
                props.conflicted(result.conflict)
                return
            }
            setNotice(rebasedNotice(base, result.upToDate, result.pushed))
            props.workPackageChanged()
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const saveRemoteBranch = () => {
        const branch = current()
        if (!branch || remoteBranch().trim() === (branch.remoteBranch ?? ""))
            return
        return run(
            "remote-branch",
            () =>
                api.updateBranch(branch.branchName, {
                    remoteBranch: remoteBranch(),
                }),
            remoteBranch().trim()
                ? "Remote branch name saved. The next push will use it."
                : "Remote branch name cleared. The next push will use the local branch name.",
        )
    }

    const descriptionDirty = () =>
        title() !== (current()?.prTitle ?? "") ||
        body() !== (current()?.prBody ?? "")
    const report = () => current()?.checks
    const missingChecks = () => {
        const completed = new Set(
            report()?.checks.map((check) => check.name) ?? [],
        )
        return props.tools.checkNames.filter((name) => !completed.has(name))
    }
    const checksStale = () => {
        const head = current()?.git.commits.at(-1)?.sha
        return Boolean(report()?.headSha && head && report()!.headSha !== head)
    }
    const checksBlocking = () => {
        if (props.tools.checkCount === 0) return ""
        if (current()?.checksRunning) return "Checks are still running."
        if (checksSupervisionActive(current()?.checksSupervision))
            return "The supervisor is still working on the checks."
        if (!report()) return "Run the checks before opening a pull request."
        if (missingChecks().length)
            return `Run the remaining checks: ${missingChecks().join(", ")}.`
        if (!report()!.passed)
            return "Resolve the failed checks, then run them again."
        if (checksStale())
            return "The checks are stale because the branch has newer commits. Run them again."
        return ""
    }

    return (
        <section class="branch-workspace mx-auto grid max-w-4xl grid-cols-1 gap-[1.1rem]">
            <TabHeading
                title={props.branch.label}
                description={
                    props.branch.origin === "existing"
                        ? "An existing branch this work package delivers through."
                        : "A branch this work package delivers through."
                }
                rename={(label) =>
                    api.updateWorkPackageBranch(
                        props.workPackage.ref,
                        props.branch.id,
                        { label },
                    )
                }
                remove={{
                    label: "Remove",
                    confirm: `Remove the '${props.branch.label}' tab? The Git branch '${props.branch.branchName}' and everything merged into it stay as they are.`,
                    run: () =>
                        api.removeWorkPackageBranch(
                            props.workPackage.ref,
                            props.branch.id,
                        ),
                }}
                changed={props.workPackageChanged}>
                <span
                    class={`badge ${props.branch.git.exists ? "success" : ""} p-[0.3rem_0.7rem]`}>
                    {props.branch.git.exists
                        ? "Local branch ready"
                        : "Not created yet"}
                </span>
            </TabHeading>
            <div class="branch-heading mb-[0.15rem]">
                <code>{props.branch.branchName}</code>
                <span class="ml-[0.65rem]">
                    from <code>{props.branch.base}</code>
                </span>
            </div>

            <Banner />
            <Show when={notice()}>
                <p class="notice success m-0" role="status">
                    {notice()}
                </p>
            </Show>

            <BranchSection
                variant="tonal"
                title="Branch name"
                description="Rename the local delivery branch while preserving its commit history.">
                <div class="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,_1fr)_250px]">
                    <label
                        class="label col-start-1"
                        for="local-branch-name-input">
                        Local Branch Name
                    </label>
                    <input
                        id="local-branch-name-input"
                        aria-label="Local delivery branch name"
                        class="code inset col-start-1 min-w-0 flex-[1_1_18rem] p-[0.6rem_0.7rem]"
                        value={branchName()}
                        disabled={!!busy()}
                        onInput={(event) =>
                            setBranchName(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void saveBranchName()
                        }}
                    />
                    <button
                        aria-busy={busy() === "branch-name" ? "true" : "false"}
                        class="outlined sm:col-start-2"
                        disabled={
                            !!busy() ||
                            !branchName().trim() ||
                            branchName().trim() === props.branch.branchName
                        }
                        onClick={() => void saveBranchName()}>
                        Rename local branch
                    </button>
                </div>
                <Show when={current()}>
                    {(branch) => (
                        <>
                            <div class="grid grid-cols-1 gap-x-3 gap-y-1 mt-4 sm:grid-cols-[minmax(0,_1fr)_250px]">
                                <label
                                    class="label col-start-1"
                                    for="remote-branch-name-input">
                                    Remote Branch Name
                                </label>
                                <input
                                    id="remote-branch-name-input"
                                    aria-label="Remote branch name"
                                    class="code inset col-start-1 min-w-0 flex-[1_1_18rem] p-[0.6rem_0.7rem]"
                                    value={remoteBranch()}
                                    disabled={!!busy()}
                                    onInput={(event) =>
                                        setRemoteBranch(
                                            event.currentTarget.value,
                                        )
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter")
                                            void saveRemoteBranch()
                                    }}
                                    placeholder={branch().branchName}
                                />
                                <button
                                    aria-busy={
                                        busy() === "remote-branch"
                                            ? "true"
                                            : "false"
                                    }
                                    class="outlined"
                                    disabled={
                                        !!busy() ||
                                        remoteBranch().trim() ===
                                            (branch().remoteBranch ?? "")
                                    }
                                    onClick={() => void saveRemoteBranch()}>
                                    Save remote branch
                                </button>
                            </div>
                        </>
                    )}
                </Show>
            </BranchSection>

            <BranchTasks
                workPackage={props.workPackage}
                branch={props.branch}
                changed={props.workPackageChanged}
            />

            <BranchSection
                variant="elevated"
                title="Contents"
                description="The commits currently unique to this branch().">
                <div class="flex flex-wrap items-center gap-[0.75rem] mb-[1rem]">
                    <button
                        aria-busy={busy() === "rebase" ? "true" : "false"}
                        class="outlined"
                        disabled={
                            !!busy() || resolving() || !props.branch.git.exists
                        }
                        title={`Replay this branch onto the latest ${props.branch.base}`}
                        onClick={rebase}>
                        Rebase on {props.branch.base}
                    </button>
                    <Show
                        when={resolving()}
                        fallback={
                            <button
                                class="outlined"
                                disabled={!!busy() || !props.branch.git.exists}
                                title="Rebase, and if it stops on conflicts, have an agent resolve them and finish it"
                                onClick={() =>
                                    setPickingRebaseSupervisor(true)
                                }>
                                Rebase on {props.branch.base} with supervisor
                            </button>
                        }>
                        <button
                            class="outlined"
                            aria-busy={stoppingRebase() ? "true" : "false"}
                            disabled={stoppingRebase()}
                            title="Stop the supervisor and abort its rebase, leaving the branch as it was"
                            onClick={() => void stopRebaseSupervisor()}>
                            Stop supervisor
                        </button>
                    </Show>
                    <Show when={busy() === "rebase"}>
                        <span class="branch-working" role="status">
                            Fetching {props.branch.base} and rebasing…
                        </span>
                    </Show>
                </div>
                <Show when={rebaseSupervision()}>
                    {(supervision) => (
                        <RebaseSupervisionStatus supervision={supervision()} />
                    )}
                </Show>
                <Show when={pickingRebaseSupervisor()}>
                    <SupervisorPickerDialog
                        title={`Rebase on ${props.branch.base} with a supervisor`}
                        description={`If the rebase stops on conflicts, the supervisor re-runs it, resolves them and finishes it. If it cannot settle a conflict, it aborts, leaving the branch as it was. It does not push.`}
                        action="Rebase"
                        previous={rebaseSupervision()?.supervisor ?? null}
                        close={() => setPickingRebaseSupervisor(false)}
                        start={rebaseWithSupervisor}
                    />
                </Show>
                <div class="branch-metrics grid grid-cols-[repeat(3,_minmax(0,_1fr))] gap-[0.75rem] max-[560px]:grid-cols-[1fr]">
                    <Metric
                        label="Commits"
                        value={props.branch.git.commits.length}
                    />
                    <Metric
                        label="Files changed"
                        value={props.branch.git.filesChanged}
                    />
                    <Metric
                        label="Ahead of base"
                        value={props.branch.git.aheadOfBase ?? "—"}
                    />
                </div>
                <Show
                    when={props.branch.git.commits.length}
                    fallback={
                        <p class="hint m-[1rem_0_0]">
                            No commits have landed on this branch yet.
                        </p>
                    }>
                    <ul class="branch-commits overflow-hidden m-[1rem_0_0] p-0">
                        <For each={props.branch.git.commits}>
                            {(commit) => (
                                <li class="flex gap-[0.8rem] p-[0.65rem_0.8rem]">
                                    <code class="flex-[0_0_auto]">
                                        {commit.shortSha}
                                    </code>
                                    <span>{commit.subject}</span>
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
            </BranchSection>

            <Show
                when={current()}
                fallback={
                    <article class="inset overflow-hidden p-[1.25rem]">
                        <h3 class="m-0">Pull request description and checks</h3>
                        <p class="m-[0.28rem_0_0]">
                            These controls become available once the branch has
                            commits that are not on its base branch().
                        </p>
                    </article>
                }>
                {(branch) => (
                    <>
                        <BranchSection
                            variant="elevated"
                            title="Pull request description"
                            description="Generate from the commits, then review or edit before opening a pull request.">
                            <div class="branch-section-actions flex flex-wrap items-center gap-[0.75rem]">
                                <button
                                    aria-busy={
                                        busy() === "describe" ? "true" : "false"
                                    }
                                    class="outlined"
                                    disabled={
                                        !!busy() ||
                                        !branch().git.commits.length ||
                                        !props.tools.prAgentAvailable
                                    }
                                    onClick={generate}>
                                    {branch().prTitle
                                        ? "Regenerate description"
                                        : "Generate description"}
                                </button>
                                <Show when={busy() === "describe"}>
                                    <span class="branch-working" role="status">
                                        The agent is reading{" "}
                                        {branch().git.commits.length} commit(s).
                                        This can take a minute or two.
                                    </span>
                                </Show>
                            </div>
                            <Show when={!props.tools.prAgentAvailable}>
                                <p class="notice warning m-[1rem_0_0] p-[0.65rem_0.8rem]">
                                    The configured PR-description agent is
                                    unavailable. You can still write the
                                    description manually.
                                </p>
                            </Show>
                            <div
                                class="segmented inset inline-flex gap-[0.2rem] m-[1rem_0_0.75rem] p-[0.2rem]"
                                role="group"
                                aria-label="Description view">
                                <button
                                    class="p-[0.38rem_0.7rem]"
                                    aria-pressed={
                                        mode() === "write" ? "true" : "false"
                                    }
                                    onClick={() => setMode("write")}>
                                    Write
                                </button>
                                <button
                                    class="p-[0.38rem_0.7rem]"
                                    aria-pressed={
                                        mode() === "preview" ? "true" : "false"
                                    }
                                    onClick={() => setMode("preview")}>
                                    Preview
                                </button>
                            </div>
                            <Show
                                when={mode() === "write"}
                                fallback={
                                    <article class="inset prose grid gap-[1rem] min-h-[10rem] p-[1rem]">
                                        <Show
                                            when={body().trim()}
                                            fallback={
                                                <p>Nothing written yet.</p>
                                            }>
                                            <div
                                                innerHTML={renderMarkdown(
                                                    body(),
                                                )}
                                            />
                                        </Show>
                                    </article>
                                }>
                                <div class="branch-description-fields grid gap-[1rem]">
                                    <label class="field">
                                        <span>Title</span>
                                        <input
                                            value={title()}
                                            onInput={(event) =>
                                                setTitle(
                                                    event.currentTarget.value,
                                                )
                                            }
                                            placeholder="Pull request title"
                                        />
                                    </label>
                                    <label class="field">
                                        <span>Body (Markdown)</span>
                                        <textarea
                                            class="min-h-[14rem]"
                                            value={body()}
                                            onInput={(event) =>
                                                setBody(
                                                    event.currentTarget.value,
                                                )
                                            }
                                            rows={12}
                                        />
                                    </label>
                                </div>
                            </Show>
                            <div class="branch-footer flex flex-wrap items-center gap-[0.75rem] mt-[0.8rem]">
                                <button
                                    class="outlined"
                                    disabled={!!busy() || !descriptionDirty()}
                                    aria-busy={
                                        busy() === "save" ? "true" : "false"
                                    }
                                    onClick={save}>
                                    Save description
                                </button>
                            </div>
                        </BranchSection>

                        <BranchSection
                            variant="tonal"
                            title="Checks"
                            description={`${props.tools.checkCount} configured command(s) · typecheck, lint and tests.`}>
                            <BranchChecks
                                branch={branch()}
                                names={props.tools.checkNames}
                                disabled={!!busy()}
                                stale={checksStale()}
                                updated={(checks) => {
                                    const value = current()
                                    if (value)
                                        setCurrent({
                                            ...snapshot(value),
                                            ...checks,
                                        })
                                }}
                                investigate={() => setCheckAgentOpen(true)}
                            />
                        </BranchSection>

                        <BranchSection
                            variant="elevated"
                            title="Pull request"
                            description="Open after the latest checks pass, or force open to bypass checks.">
                            <Show
                                when={branch().prUrl}
                                fallback={
                                    <div class="pull-request-step grid gap-[0.8rem]">
                                        <Show when={checksBlocking()}>
                                            {(reason) => (
                                                <p class="hint m-0">
                                                    {reason()}
                                                </p>
                                            )}
                                        </Show>
                                        <Show when={!title().trim()}>
                                            <p class="hint m-0">
                                                Add a pull request title before
                                                opening it.
                                            </p>
                                        </Show>
                                        <div class="branch-pr-actions flex flex-wrap gap-[0.5rem]">
                                            <button
                                                aria-busy={
                                                    busy() === "pr-draft"
                                                        ? "true"
                                                        : "false"
                                                }
                                                class="outlined"
                                                disabled={
                                                    !!busy() ||
                                                    !title().trim() ||
                                                    !branch().git.exists ||
                                                    !!checksBlocking()
                                                }
                                                onClick={() => openPr(true)}>
                                                Open as draft
                                            </button>
                                            <button
                                                aria-busy={
                                                    busy() === "pr"
                                                        ? "true"
                                                        : "false"
                                                }
                                                class="primary"
                                                disabled={
                                                    !!busy() ||
                                                    !title().trim() ||
                                                    !branch().git.exists ||
                                                    !!checksBlocking()
                                                }
                                                onClick={() => openPr(false)}>
                                                Open pull request
                                            </button>
                                        </div>
                                        <Show when={checksBlocking()}>
                                            <div class="mt-2 border-t border-current/10 pt-3">
                                                <p class="hint m-[0_0_0.6rem]">
                                                    Open a pull request without
                                                    waiting for checks to pass.
                                                </p>
                                                <button
                                                    type="button"
                                                    class="outlined"
                                                    aria-busy={
                                                        busy() === "pr-force"
                                                            ? "true"
                                                            : "false"
                                                    }
                                                    disabled={
                                                        !!busy() ||
                                                        !title().trim() ||
                                                        !branch().git.exists
                                                    }
                                                    onClick={() =>
                                                        openPr(false, true)
                                                    }>
                                                    Force open pull request
                                                </button>
                                            </div>
                                        </Show>
                                    </div>
                                }>
                                <div class="pull-request-open flex flex-wrap items-center justify-between gap-[1rem]">
                                    <span>Pull request opened</span>
                                    <div class="flex flex-wrap items-center gap-[0.5rem]">
                                        <Show when={branch().git.unpushed}>
                                            {(unpushed) => (
                                                <button
                                                    aria-busy={
                                                        busy() === "push"
                                                            ? "true"
                                                            : "false"
                                                    }
                                                    class="outlined"
                                                    disabled={!!busy()}
                                                    title={
                                                        branch().git.diverged
                                                            ? "The branch was rewritten since it was pushed, so this push forces (with lease)."
                                                            : undefined
                                                    }
                                                    onClick={push}>
                                                    {branch().git.diverged
                                                        ? "Force push"
                                                        : "Push"}{" "}
                                                    {unpushed()} new commit
                                                    {unpushed() === 1
                                                        ? ""
                                                        : "s"}
                                                </button>
                                            )}
                                        </Show>
                                        <a
                                            class="primary"
                                            href={branch().prUrl!}
                                            target="_blank"
                                            rel="noreferrer">
                                            View pull request
                                        </a>
                                    </div>
                                </div>
                            </Show>
                        </BranchSection>

                        <Show when={checkAgentOpen()}>
                            {/* Not keyed: the report object is replaced on every refresh, which would remount the dialog and reset its inputs. */}
                            <Show when={!!report()}>
                                <BranchCheckLauncher
                                    branch={branch()}
                                    report={report()!}
                                    close={() => setCheckAgentOpen(false)}
                                    started={() =>
                                        setNotice(
                                            "Agent started with the failed check report.",
                                        )
                                    }
                                />
                            </Show>
                        </Show>
                    </>
                )}
            </Show>
        </section>
    )
}

const rebaseEnded: Record<
    Exclude<RebaseSupervision["status"], "resolving" | "rebased">,
    string
> = {
    blocked: "The supervisor stopped",
    failed: "The supervised rebase failed",
    stopped: "The supervised rebase was stopped",
}

/** Where a supervised rebase has got to, with the supervisor's output. */
function RebaseSupervisionStatus(props: { supervision: RebaseSupervision }) {
    const files = () => props.supervision.conflict.files.length
    const message = () => {
        const { status, onto, stopReason, pushed } = props.supervision
        if (status === "resolving")
            return `The rebase onto ${onto} stopped on conflicts in ${files()} file${files() === 1 ? "" : "s"}. The supervisor is resolving them. You can leave this page.`
        if (status === "rebased")
            return `The supervisor resolved the conflicts and rebased onto ${onto}.${pushed ? " It was pushed before, so the next push has to force." : ""}`
        return `${rebaseEnded[status]}${stopReason ? `: ${stopReason}` : "."}`
    }
    const warning = () =>
        props.supervision.status !== "resolving" &&
        props.supervision.status !== "rebased"
    return (
        <div class="mb-[1rem] grid gap-[0.5rem]">
            <p
                class={warning() ? "notice warning m-0" : "hint m-0"}
                role="status"
                aria-busy={
                    props.supervision.status === "resolving" ? "true" : "false"
                }>
                {message()}
            </p>
            <Show when={props.supervision.agent}>
                {(agent) => (
                    <>
                        <div class="justify-self-start">
                            <ResumeSessionButton agent={agent()} />
                        </div>
                        <details
                            open={props.supervision.status === "resolving"}>
                            <summary class="cursor-pointer">
                                Supervisor output
                            </summary>
                            <div class="mt-2">
                                <AgentOutput
                                    agent={agent()}
                                    label="Supervisor"
                                />
                            </div>
                        </details>
                    </>
                )}
            </Show>
        </div>
    )
}

function BranchSection(props: {
    title: string
    description: string
    variant?: "elevated" | "tonal"
    children: Element
}) {
    return (
        <article
            class={`${props.variant ?? "elevated"} overflow-hidden [&>header]:p-[1.15rem_1.25rem_0.35rem] [&>header_h3]:m-0 [&>header_p]:m-[0.28rem_0_0]`}>
            <header>
                <div>
                    <h3>{props.title}</h3>
                    <p>{props.description}</p>
                </div>
            </header>
            <div class="branch-section-body p-[1rem_1.25rem_1.25rem]">
                {props.children}
            </div>
        </article>
    )
}

function Metric(props: { label: string; value: string | number }) {
    return (
        <article class="inset p-4">
            <strong class="block text-xl">{props.value}</strong>
            <span class="caption muted">{props.label}</span>
        </article>
    )
}
