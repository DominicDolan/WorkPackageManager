import {
    type CheckRun,
    type CombinedBranchDetail,
    type WorkPackageDetail,
} from "@shared/types"
import {
    action,
    createOptimistic,
    For,
    Show,
    createEffect,
    createSignal,
    onSettled,
    type Element,
} from "solid-js"
import { api } from "../api"
import { renderMarkdown } from "../markdown"
import type { WorkspaceSnapshot } from "../types/workspace"
import { BranchCheckLauncher } from "./BranchCheckLauncher"

export function BranchPanel(props: {
    workPackage: WorkPackageDetail
    branch?: CombinedBranchDetail
    tools: WorkspaceSnapshot["tools"]
    changed: () => void
    workPackageChanged: () => void
}) {
    const [current, setCurrent] = createSignal<
        CombinedBranchDetail | undefined
    >()
    const [branchName, setBranchName] = createSignal(
        props.workPackage.branchName,
    )
    const [remoteBranch, setRemoteBranch] = createSignal("")
    const [title, setTitle] = createSignal("")
    const [body, setBody] = createSignal("")
    const [mode, setMode] = createSignal<"write" | "preview">("write")
    const [busy, setBusy] = createOptimistic("")
    const [requestedCheck, setRequestedCheck] = createOptimistic<string | null>(
        null,
    )
    const [error, setError] = createSignal("")
    const [notice, setNotice] = createSignal("")
    const [checkAgentOpen, setCheckAgentOpen] = createSignal(false)

    const applyBranch = (branch: CombinedBranchDetail) => {
        setCurrent(branch)
        setTitle(branch.prTitle ?? "")
        setBody(branch.prBody ?? "")
    }
    createEffect(
        () => props.branch,
        (branch) => {
            if (branch && branch.updatedAt !== current()?.updatedAt)
                applyBranch(branch)
            if (!branch) setCurrent(undefined)
        },
    )
    createEffect(
        () => props.workPackage.branchName,
        (name) => {
            setBranchName(name)
        },
    )
    createEffect(
        () => current()?.remoteBranch ?? "",
        (name) => {
            setRemoteBranch(name)
        },
    )

    const run = action(async function* (
        label: string,
        request: () => Promise<CombinedBranchDetail>,
        message: string,
        check?: string,
    ) {
        if (busy()) return

        setBusy(label)
        if (label === "checks")
            setRequestedCheck(check ?? props.tools.checkNames[0] ?? null)
        setError("")
        setNotice("")
        try {
            const branch = await request()
            yield
            applyBranch(branch)
            setNotice(message)
            props.changed()
        } catch (caught) {
            yield
            setError(caught instanceof Error ? caught.message : String(caught))
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
    const runChecks = (check?: string) => {
        const branch = current()
        if (branch)
            return run(
                "checks",
                () => api.runChecks(branch.branchName, check),
                check
                    ? `${check} started. Progress and results will appear below.`
                    : "Checks started. Progress and results will appear below.",
                check,
            )
    }
    const openPr = action(async function* (draft: boolean) {
        if (busy()) return

        const branch = current()
        if (!branch) return
        setBusy(draft ? "pr-draft" : "pr")
        setError("")
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
            const result = await api.createPr(latest.branchName, draft)
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
            setError(caught instanceof Error ? caught.message : String(caught))
        }
    })
    const saveBranchName = action(function* () {
        if (busy()) return

        const next = branchName().trim()
        if (!next || next === props.workPackage.branchName) return
        setBusy("branch-name")
        setError("")
        setNotice("")
        try {
            yield api.updateWorkPackage(props.workPackage.ref, {
                branchName: next,
            })

            setNotice(
                props.workPackage.git.exists
                    ? "Local branch renamed with its commit history."
                    : "Delivery branch name updated.",
            )
            props.workPackageChanged()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
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

    // A check run can continue beyond the initiating request. Keep its progress
    // and eventual report visible without requiring a manual page refresh.
    onSettled(() => {
        const poll = setInterval(() => {
            const branch = current()
            if (!branch?.checksRunning) return
            api.getBranch(branch.branchName)
                .then(setCurrent)
                .catch(() => undefined)
        }, 2000)
        return () => clearInterval(poll)
    })

    const descriptionDirty = () =>
        title() !== (current()?.prTitle ?? "") ||
        body() !== (current()?.prBody ?? "")
    const report = () => current()?.checks
    const checkRunning = (name: string) =>
        (current()?.checksRunning?.current ?? requestedCheck()) === name
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
        if (!report()) return "Run the checks before opening a pull request."
        if (missingChecks().length)
            return `Run the remaining checks: ${missingChecks().join(", ")}.`
        if (!report()!.passed)
            return "Resolve the failed checks, then run them again."
        if (checksStale())
            return "The checks are stale because the branch has newer commits. Run them again."
        return ""
    }
    const formatDate = (value: string) => new Date(value).toLocaleString()
    const seconds = (ms: number) =>
        `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
    const checkLabel: Record<CheckRun["status"], string> = {
        passed: "Passed",
        failed: "Failed",
        skipped: "Skipped",
        timed_out: "Timed out",
        error: "Error",
    }

    return (
        <section class="branch-workspace mx-auto max-w-4xl grid gap-[1.1rem]">
            <div class="branch-heading flex items-start justify-between gap-[1rem] mb-[0.15rem] [&_h2]:m-[0_0_0.55rem] [&_div>span]:ml-[0.65rem] max-[560px]:block">
                <div>
                    <h2>Delivery branch</h2>
                    <code>{props.workPackage.branchName}</code>
                    <span>
                        from <code>{props.workPackage.baseBranch}</code>
                    </span>
                </div>
                <span
                    class={`badge ${props.workPackage.git.exists ? "success" : ""} p-[0.3rem_0.7rem] max-[560px]:inline-block max-[560px]:mt-[0.8rem]`}
                >
                    {props.workPackage.git.exists
                        ? "Local branch ready"
                        : "Not created yet"}
                </span>
            </div>

            <Show when={error()}>
                <p class="notice error">{error()}</p>
            </Show>
            <Show when={notice()}>
                <p class="notice success m-0" role="status">
                    {notice()}
                </p>
            </Show>

            <BranchSection
                variant="tonal"
                title="Branch name"
                description="Rename the local delivery branch while preserving its commit history."
            >
                <div class="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,_1fr)_250px]">
                    <label
                        class="label col-start-1"
                        for="local-branch-name-input"
                    >
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
                            branchName().trim() === props.workPackage.branchName
                        }
                        onClick={() => void saveBranchName()}
                    >
                        Rename local branch
                    </button>
                </div>
                <Show when={current()} keyed>
                    {(branch) => (
                        <>
                            <div class="grid grid-cols-1 gap-x-3 gap-y-1 mt-4 sm:grid-cols-[minmax(0,_1fr)_250px]">
                                <label
                                    class="label col-start-1"
                                    for="remote-branch-name-input"
                                >
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
                                    placeholder={branch.branchName}
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
                                            (branch.remoteBranch ?? "")
                                    }
                                    onClick={() => void saveRemoteBranch()}
                                >
                                    Save remote branch
                                </button>
                            </div>
                        </>
                    )}
                </Show>
            </BranchSection>

            <BranchSection
                variant="elevated"
                title="Contents"
                description="The commits currently unique to this work package branch."
            >
                <div class="branch-metrics grid grid-cols-[repeat(3,_minmax(0,_1fr))] gap-[0.75rem] max-[560px]:grid-cols-[1fr]">
                    <Metric
                        label="Commits"
                        value={props.workPackage.git.commits.length}
                    />
                    <Metric
                        label="Files changed"
                        value={props.workPackage.git.filesChanged}
                    />
                    <Metric
                        label="Ahead of base"
                        value={props.workPackage.git.aheadOfBase ?? "—"}
                    />
                </div>
                <Show
                    when={props.workPackage.git.commits.length}
                    fallback={
                        <p class="hint m-[1rem_0_0]">
                            No commits have landed on this branch yet.
                        </p>
                    }
                >
                    <ul class="branch-commits overflow-hidden m-[1rem_0_0] p-0 [&_li]:flex [&_li]:gap-[0.8rem] [&_li]:p-[0.65rem_0.8rem] [&_code]:flex-[0_0_auto]">
                        <For each={props.workPackage.git.commits}>
                            {(commit) => (
                                <li>
                                    <code>{commit.shortSha}</code>
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
                    <article class="inset overflow-hidden [&>header]:p-[1.15rem_1.25rem_0.35rem] [&>header_h3]:m-0 [&>header_p]:m-[0.28rem_0_0] [&_h3]:m-0 [&_p]:m-[0.28rem_0_0] p-[1.25rem]">
                        <h3>Pull request description and checks</h3>
                        <p>
                            These controls become available once the branch has
                            commits that are not on its base branch.
                        </p>
                    </article>
                }
                keyed
            >
                {(branch) => (
                    <>
                        <BranchSection
                            variant="elevated"
                            title="Pull request description"
                            description="Generate from the commits, then review or edit before opening a pull request."
                        >
                            <div class="branch-section-actions flex flex-wrap items-center gap-[0.75rem]">
                                <button
                                    aria-busy={
                                        busy() === "describe" ? "true" : "false"
                                    }
                                    class="outlined"
                                    disabled={
                                        !!busy() ||
                                        !branch.git.commits.length ||
                                        !props.tools.prAgentAvailable
                                    }
                                    onClick={generate}
                                >
                                    {branch.prTitle
                                        ? "Regenerate description"
                                        : "Generate description"}
                                </button>
                                <Show when={busy() === "describe"}>
                                    <span class="branch-working" role="status">
                                        The agent is reading{" "}
                                        {branch.git.commits.length} commit(s).
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
                                class="segmented inset inline-flex gap-[0.2rem] m-[1rem_0_0.75rem] p-[0.2rem] [&_button]:p-[0.38rem_0.7rem]"
                                role="group"
                                aria-label="Description view"
                            >
                                <button
                                    aria-pressed={
                                        mode() === "write" ? "true" : "false"
                                    }
                                    onClick={() => setMode("write")}
                                >
                                    Write
                                </button>
                                <button
                                    aria-pressed={
                                        mode() === "preview" ? "true" : "false"
                                    }
                                    onClick={() => setMode("preview")}
                                >
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
                                            }
                                        >
                                            <div
                                                innerHTML={renderMarkdown(
                                                    body(),
                                                )}
                                            />
                                        </Show>
                                    </article>
                                }
                            >
                                <div class="branch-description-fields grid gap-[1rem] [&_textarea]:min-h-[14rem]">
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
                            <div class="branch-footer flex flex-wrap items-center gap-[0.75rem] mt-[0.8rem] [&_.spacer]:flex-1">
                                <button
                                    class="outlined"
                                    disabled={!!busy() || !descriptionDirty()}
                                    aria-busy={
                                        busy() === "save" ? "true" : "false"
                                    }
                                    onClick={save}
                                >
                                    Save description
                                </button>
                            </div>
                        </BranchSection>

                        <BranchSection
                            variant="tonal"
                            title="Checks"
                            description={`${props.tools.checkCount} configured command(s) · typecheck, lint and tests.`}
                        >
                            <div class="branch-section-actions flex flex-wrap items-center gap-[0.75rem]">
                                <button
                                    aria-busy={
                                        busy() === "checks" ||
                                        branch.checksRunning
                                            ? "true"
                                            : "false"
                                    }
                                    class="outlined"
                                    disabled={
                                        !!busy() ||
                                        !!branch.checksRunning ||
                                        !branch.git.exists ||
                                        props.tools.checkCount === 0
                                    }
                                    onClick={() => runChecks()}
                                >
                                    {report()
                                        ? "Run all again"
                                        : "Run all checks"}
                                </button>
                            </div>
                            <Show when={branch.checksRunning}>
                                {(progress) => (
                                    <p
                                        class="notice success m-0 mt-[1rem]"
                                        role="status"
                                    >
                                        Running{" "}
                                        <strong>
                                            {progress().current ??
                                                "the first check"}
                                        </strong>
                                        {progress().total
                                            ? ` · ${progress().done + 1} of ${progress().total}`
                                            : ""}
                                        . This continues if you leave the page.
                                    </p>
                                )}
                            </Show>
                            <Show when={props.tools.checkCount === 0}>
                                <p class="hint m-[1rem_0_0]">
                                    No pre-PR checks are configured for this
                                    repository.
                                </p>
                            </Show>
                            <Show
                                when={props.tools.checkCount > 0 && !report()}
                            >
                                <div>
                                    <p class="hint m-[1rem_0_0]">
                                        Checks have not been run on this branch
                                        yet.
                                    </p>
                                    <ul class="branch-checks overflow-hidden m-[1rem_0_0] p-0 [&_.check-row]:flex [&_.check-row]:items-start [&_.check-row_details]:min-w-0 [&_.check-row_details]:flex-1 [&_.check-run-button]:flex-[0_0_auto] [&_.check-run-button]:m-[0.45rem_0.7rem_0.45rem_0] [&_.check-not-run-row]:items-center [&_.check-not-run-row]:gap-[0.7rem] [&_.check-not-run-row]:pl-[0.8rem] [&_.check-not-run-row_strong]:min-w-[7rem] [&_.check-not-run-row_strong]:flex-1 [&_summary]:grid [&_summary]:min-h-[3.4rem] [&_summary]:grid-cols-[auto_minmax(7rem,_1fr)_minmax(10rem,_2fr)_auto] [&_summary]:items-center [&_summary]:gap-[0.7rem] [&_summary]:p-[0.7rem_0.8rem] [&_summary_code]:overflow-hidden [&_details>p]:m-0 [&_details>p]:p-[0_0.8rem_0.7rem] [&_pre]:max-h-[26rem] [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:p-[0.9rem] max-[560px]:[&_summary]:grid-cols-[auto_1fr_auto] max-[560px]:[&_summary_code]:col-[2_/_-1] max-[560px]:[&_summary_code]:row-[2]">
                                        <For each={props.tools.checkNames}>
                                            {(check) => (
                                                <li
                                                    class="check-row check-not-run-row"
                                                    aria-busy={
                                                        checkRunning(check)
                                                            ? "true"
                                                            : "false"
                                                    }
                                                >
                                                    <span
                                                        data-status={
                                                            checkRunning(check)
                                                                ? "running"
                                                                : "not-run"
                                                        }
                                                        class="badge inline-flex items-center p-[0.18rem_0.5rem]"
                                                    >
                                                        {checkRunning(check)
                                                            ? "Running"
                                                            : "Not run"}
                                                    </span>
                                                    <strong>{check}</strong>
                                                    <button
                                                        class="outlined check-run-button"
                                                        disabled={
                                                            !!busy() ||
                                                            !!branch.checksRunning ||
                                                            !branch.git.exists
                                                        }
                                                        onClick={() =>
                                                            runChecks(check)
                                                        }
                                                    >
                                                        Run
                                                    </button>
                                                </li>
                                            )}
                                        </For>
                                    </ul>
                                </div>
                            </Show>
                            <Show when={report()}>
                                {(checks) => (
                                    <div class="check-report mt-[1rem]">
                                        <div class="hint flex flex-wrap items-center gap-[0.75rem]">
                                            <span
                                                class="badge inline-flex items-center p-[0.18rem_0.5rem]"
                                                data-status={
                                                    checks().passed
                                                        ? "passed"
                                                        : "failed"
                                                }
                                            >
                                                {checks().passed
                                                    ? "Passed"
                                                    : missingChecks().length
                                                      ? "Incomplete"
                                                      : "Failed"}
                                            </span>
                                            <span>
                                                Last updated{" "}
                                                {formatDate(checks().ranAt)}{" "}
                                                against{" "}
                                                <code>{checks().base}</code>
                                            </span>
                                            <Show when={!checks().passed}>
                                                <button
                                                    class="outlined check-agent-button ml-auto max-[560px]:w-full max-[560px]:ml-0"
                                                    disabled={!!busy()}
                                                    onClick={() =>
                                                        setCheckAgentOpen(true)
                                                    }
                                                >
                                                    Investigate with agent
                                                </button>
                                            </Show>
                                        </div>
                                        <Show when={checksStale()}>
                                            <p class="notice warning m-[1rem_0_0] p-[0.65rem_0.8rem]">
                                                The branch has new commits since
                                                this report was produced, so
                                                these results are stale.
                                            </p>
                                        </Show>
                                        <ul class="branch-checks overflow-hidden m-[1rem_0_0] p-0 [&_.check-row]:flex [&_.check-row]:items-start [&_.check-row_details]:min-w-0 [&_.check-row_details]:flex-1 [&_.check-run-button]:flex-[0_0_auto] [&_.check-run-button]:m-[0.45rem_0.7rem_0.45rem_0] [&_.check-not-run-row]:items-center [&_.check-not-run-row]:gap-[0.7rem] [&_.check-not-run-row]:pl-[0.8rem] [&_.check-not-run-row_strong]:min-w-[7rem] [&_.check-not-run-row_strong]:flex-1 [&_summary]:grid [&_summary]:min-h-[3.4rem] [&_summary]:grid-cols-[auto_minmax(7rem,_1fr)_minmax(10rem,_2fr)_auto] [&_summary]:items-center [&_summary]:gap-[0.7rem] [&_summary]:p-[0.7rem_0.8rem] [&_summary_code]:overflow-hidden [&_details>p]:m-0 [&_details>p]:p-[0_0.8rem_0.7rem] [&_pre]:max-h-[26rem] [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:p-[0.9rem] max-[560px]:[&_summary]:grid-cols-[auto_1fr_auto] max-[560px]:[&_summary_code]:col-[2_/_-1] max-[560px]:[&_summary_code]:row-[2]">
                                            <For each={checks().checks}>
                                                {(check) => (
                                                    <li
                                                        class="check-row"
                                                        aria-busy={
                                                            checkRunning(
                                                                check.name,
                                                            )
                                                                ? "true"
                                                                : "false"
                                                        }
                                                    >
                                                        <details
                                                            open={
                                                                check.status !==
                                                                    "passed" &&
                                                                check.status !==
                                                                    "skipped"
                                                            }
                                                        >
                                                            <summary>
                                                                <span
                                                                    class="badge inline-flex items-center p-[0.18rem_0.5rem]"
                                                                    data-status={
                                                                        checkRunning(
                                                                            check.name,
                                                                        )
                                                                            ? "running"
                                                                            : check.status
                                                                    }
                                                                >
                                                                    {checkRunning(
                                                                        check.name,
                                                                    )
                                                                        ? "Running"
                                                                        : checkLabel[
                                                                              check
                                                                                  .status
                                                                          ]}
                                                                </span>
                                                                <strong>
                                                                    {check.name}
                                                                </strong>
                                                                <code>
                                                                    {check.command.join(
                                                                        " ",
                                                                    )}
                                                                </code>
                                                                <span>
                                                                    {seconds(
                                                                        check.durationMs,
                                                                    )}
                                                                </span>
                                                            </summary>
                                                            <Show
                                                                when={
                                                                    check.reason
                                                                }
                                                            >
                                                                <p>
                                                                    {
                                                                        check.reason
                                                                    }
                                                                </p>
                                                            </Show>
                                                            <Show
                                                                when={
                                                                    check.output
                                                                }
                                                            >
                                                                <pre>
                                                                    {
                                                                        check.output
                                                                    }
                                                                </pre>
                                                            </Show>
                                                        </details>
                                                        <button
                                                            class="outlined check-run-button"
                                                            disabled={
                                                                !!busy() ||
                                                                !!branch.checksRunning ||
                                                                !branch.git
                                                                    .exists
                                                            }
                                                            onClick={() =>
                                                                runChecks(
                                                                    check.name,
                                                                )
                                                            }
                                                        >
                                                            Run
                                                        </button>
                                                    </li>
                                                )}
                                            </For>
                                            <For each={missingChecks()}>
                                                {(check) => (
                                                    <li
                                                        class="check-row check-not-run-row"
                                                        aria-busy={
                                                            checkRunning(check)
                                                                ? "true"
                                                                : "false"
                                                        }
                                                    >
                                                        <span
                                                            data-status={
                                                                checkRunning(
                                                                    check,
                                                                )
                                                                    ? "running"
                                                                    : "not-run"
                                                            }
                                                            class="badge inline-flex items-center p-[0.18rem_0.5rem]"
                                                        >
                                                            {checkRunning(check)
                                                                ? "Running"
                                                                : "Not run"}
                                                        </span>
                                                        <strong>{check}</strong>
                                                        <button
                                                            class="outlined check-run-button"
                                                            disabled={
                                                                !!busy() ||
                                                                !!branch.checksRunning ||
                                                                !branch.git
                                                                    .exists
                                                            }
                                                            onClick={() =>
                                                                runChecks(check)
                                                            }
                                                        >
                                                            Run
                                                        </button>
                                                    </li>
                                                )}
                                            </For>
                                        </ul>
                                    </div>
                                )}
                            </Show>
                        </BranchSection>

                        <BranchSection
                            variant="elevated"
                            title="Pull request"
                            description="Available after the description is ready and the latest checks pass."
                        >
                            <Show
                                when={branch.prUrl}
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
                                                    !branch.git.exists ||
                                                    !!checksBlocking()
                                                }
                                                onClick={() => openPr(true)}
                                            >
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
                                                    !branch.git.exists ||
                                                    !!checksBlocking()
                                                }
                                                onClick={() => openPr(false)}
                                            >
                                                Open pull request
                                            </button>
                                        </div>
                                    </div>
                                }
                            >
                                <div class="pull-request-open flex flex-wrap items-center justify-between gap-[1rem]">
                                    <span>Pull request opened</span>
                                    <a
                                        class="primary"
                                        href={branch.prUrl!}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        View pull request
                                    </a>
                                </div>
                            </Show>
                        </BranchSection>

                        <Show when={checkAgentOpen()}>
                            <Show when={report()} keyed>
                                {(checks) => (
                                    <BranchCheckLauncher
                                        branch={branch}
                                        report={checks}
                                        close={() => setCheckAgentOpen(false)}
                                        started={() =>
                                            setNotice(
                                                "Agent started with the failed check report.",
                                            )
                                        }
                                    />
                                )}
                            </Show>
                        </Show>
                    </>
                )}
            </Show>
        </section>
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
            class={`${props.variant ?? "elevated"} overflow-hidden [&>header]:p-[1.15rem_1.25rem_0.35rem] [&>header_h3]:m-0 [&>header_p]:m-[0.28rem_0_0]`}
        >
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
