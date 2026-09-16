import {
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    createSignal,
    onSettled,
    refresh,
    type Element,
} from "solid-js"
import {
    WORK_PACKAGE_RUN_STATUS_LABELS,
    INVESTIGATION_STATUS_LABELS,
    workPackageRunActive,
    nextWorkableTask,
    type CombinedBranchDetail,
    type CheckRun,
    type Investigation,
    type InvestigationDetail,
    type Task,
    type WorkPackageDetail,
} from "@shared/types"
import { api } from "../api"
import { renderMarkdown } from "../markdown"
import { AgentLauncher } from "../AgentLauncher/AgentLauncher"
import { CreateTask } from "../CreateTask/CreateTask"
import { BranchCheckLauncher } from "./BranchCheckLauncher"
import { InvestigationLauncher } from "../InvestigationLauncher/InvestigationLauncher"
import { Brand } from "../components/Brand"
import { AttachedNotes } from "../components/AttachedNotes"
import { InfoCard } from "../components/InfoCard"
import { PageSkeleton } from "../components/PageSkeleton"
import { StatusBadge } from "../components/StatusBadge"
import { BackIcon, PlusIcon } from "../components/icons"
import type { WorkspaceSnapshot } from "../types/workspace"
import { UNASSIGNED_REF } from "../utils/workPackages"
import styles from "./WorkPackageWorkspace.module.css"

export function WorkPackageWorkspace(props: {
    workPackageRef: string
    snapshot: WorkspaceSnapshot
    back: () => void
    openTask: (ref: string) => void
    openNote: (path: string) => void
    changed: () => void
    revision: number
}) {
    const legacy = () => props.workPackageRef === UNASSIGNED_REF
    const workPackage = createMemo(
        async (): Promise<WorkPackageDetail | null> =>
            legacy() ? null : api.getWorkPackage(props.workPackageRef),
    )
    const [agentOpen, setAgentOpen] = createSignal(false)
    const [createTaskOpen, setCreateTaskOpen] = createSignal(false)
    const [investigationRunOpen, setInvestigationRunOpen] = createSignal(false)
    const [error, setError] = createSignal("")
    const [busy, setBusy] = createSignal("")
    const [selectedTab, setSelectedTab] = createSignal<
        "overview" | "investigation" | "branch" | null
    >(null)

    createEffect(
        () => props.revision,
        () => {
            void refresh(workPackage)
        },
    )

    const loose = () =>
        props.snapshot.tasks.filter((task) => !task.workPackageRef)
    const mutate = async (label: string, action: () => Promise<unknown>) => {
        setBusy(label)
        setError("")
        try {
            await action()
            refresh(workPackage)
            props.changed()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy("")
        }
    }

    return (
        <main
            class={`${styles.scope} workspace-page min-h-screen text-slate-950`}
        >
            <Loading fallback={<PageSkeleton />}>
                <Show when={legacy()} fallback={<WorkPackageContent />}>
                    <LegacyWorkPackage
                        tasks={loose()}
                        back={props.back}
                        openTask={props.openTask}
                    />
                </Show>
            </Loading>
        </main>
    )

    function WorkPackageContent() {
        return (
            <Show when={workPackage()} keyed>
                {(detail) => {
                    const investigation = () =>
                        props.snapshot.investigations.find(
                            (item) => item.ref === detail.investigationRef,
                        )
                    const branch = () =>
                        props.snapshot.branches.find(
                            (item) => item.branchName === detail.branchName,
                        ) ??
                        (detail.delivery
                            ? {
                                  ...detail.delivery,
                                  git: detail.git,
                                  tasks: detail.delivery.taskRefs
                                      .map((ref) =>
                                          detail.tasks.find(
                                              (task) => task.ref === ref,
                                          ),
                                      )
                                      .filter(
                                          (task): task is Task =>
                                              task !== undefined,
                                      ),
                                  checksRunning: null,
                              }
                            : undefined)
                    const tab = () =>
                        selectedTab() ??
                        (detail.tasks.length ? "overview" : "investigation")
                    const setTab = (
                        value: "overview" | "investigation" | "branch",
                    ) => setSelectedTab(value)
                    return (
                        <>
                            <header class="workspace-header">
                                <div class="workspace-topbar">
                                    <Brand compact />
                                    <span class="topbar-divider" />
                                    <span>{detail.name}</span>
                                </div>
                                <div class="mx-auto max-w-[1600px] px-5 pb-0 pt-5 sm:px-8">
                                    <button
                                        class="back-link"
                                        onClick={props.back}
                                    >
                                        <BackIcon />
                                        All work packages
                                    </button>
                                    <div class="mt-5 flex flex-wrap items-end justify-between gap-5">
                                        <div>
                                            <div class="work-package-context">
                                                <span
                                                    style={{
                                                        background:
                                                            detail.color,
                                                    }}
                                                />
                                                <span>{detail.ref}</span>
                                            </div>
                                            <h1 class="workspace-title">
                                                {detail.name}
                                            </h1>
                                            <p class="workspace-description">
                                                {detail.description ||
                                                    "Add a description to define the outcome for this work package."}
                                            </p>
                                        </div>
                                        <div class="flex flex-wrap items-center justify-end gap-2">
                                            <button
                                                class="button"
                                                onClick={() =>
                                                    setCreateTaskOpen(true)
                                                }
                                            >
                                                <PlusIcon />
                                                Add task
                                            </button>
                                            <Show
                                                when={detail.tasks.length > 0}
                                                fallback={
                                                    <button
                                                        class="button-primary"
                                                        onClick={() =>
                                                            investigation()
                                                                ? setInvestigationRunOpen(
                                                                      true,
                                                                  )
                                                                : setTab(
                                                                      "investigation",
                                                                  )
                                                        }
                                                    >
                                                        {investigation()
                                                            ?.status ===
                                                        "complete"
                                                            ? "Run investigation again"
                                                            : "Run investigation"}
                                                    </button>
                                                }
                                            >
                                                <button
                                                    class="button-primary"
                                                    disabled={
                                                        !detail.queue.length ||
                                                        workPackageRunActive(
                                                            detail.run,
                                                        )
                                                    }
                                                    onClick={() =>
                                                        setAgentOpen(true)
                                                    }
                                                >
                                                    {workPackageRunActive(
                                                        detail.run,
                                                    )
                                                        ? "Work package is running…"
                                                        : "Work with an agent"}
                                                </button>
                                            </Show>
                                        </div>
                                    </div>
                                    <nav class="workspace-tabs">
                                        <Tab
                                            active={tab() === "overview"}
                                            onClick={() => setTab("overview")}
                                        >
                                            Tasks
                                        </Tab>
                                        <Tab
                                            active={tab() === "investigation"}
                                            onClick={() =>
                                                setTab("investigation")
                                            }
                                        >
                                            Investigation
                                        </Tab>
                                        <Tab
                                            active={tab() === "branch"}
                                            onClick={() => setTab("branch")}
                                        >
                                            Branch
                                        </Tab>
                                    </nav>
                                </div>
                            </header>
                            <div class="mx-auto max-w-[1600px] px-5 py-8 sm:px-8">
                                <Show when={error()}>
                                    <p class="banner mb-5">{error()}</p>
                                </Show>
                                <Show when={tab() === "overview"}>
                                    <WorkPackageOverview
                                        workPackage={detail}
                                        openTask={props.openTask}
                                        busy={busy()}
                                        mutate={mutate}
                                        openNote={props.openNote}
                                        notesChanged={() => {
                                            refresh(workPackage)
                                            props.changed()
                                        }}
                                    />
                                </Show>
                                <Show when={tab() === "investigation"}>
                                    <InvestigationPanel
                                        investigation={investigation()}
                                        workPackage={detail}
                                        changed={() => {
                                            props.changed()
                                            refresh(workPackage)
                                        }}
                                    />
                                </Show>
                                <Show when={tab() === "branch"}>
                                    <BranchPanel
                                        workPackage={detail}
                                        branch={branch()}
                                        tools={props.snapshot.tools}
                                        changed={props.changed}
                                        workPackageChanged={() => {
                                            refresh(workPackage)
                                            props.changed()
                                        }}
                                    />
                                </Show>
                            </div>
                            <Show when={agentOpen()}>
                                <AgentLauncher
                                    workPackage={detail}
                                    close={() => setAgentOpen(false)}
                                    finished={() => {
                                        refresh(workPackage)
                                        props.changed()
                                    }}
                                />
                            </Show>
                            <Show when={createTaskOpen()}>
                                <CreateTask
                                    workPackage={detail}
                                    close={() => setCreateTaskOpen(false)}
                                    created={(ref) => {
                                        setCreateTaskOpen(false)
                                        refresh(workPackage)
                                        props.changed()
                                        props.openTask(ref)
                                    }}
                                />
                            </Show>
                            <Show when={investigationRunOpen()}>
                                <Show when={investigation()} keyed>
                                    {(item) => (
                                        <InvestigationLauncher
                                            investigation={item}
                                            close={() =>
                                                setInvestigationRunOpen(false)
                                            }
                                            started={() => {
                                                refresh(workPackage)
                                                props.changed()
                                            }}
                                        />
                                    )}
                                </Show>
                            </Show>
                        </>
                    )
                }}
            </Show>
        )
    }
}

function Tab(props: {
    active: boolean
    onClick: () => void
    children: Element
}) {
    return (
        <button
            class={`workspace-tab ${props.active ? "workspace-tab-active" : ""}`}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    )
}

function WorkPackageOverview(props: {
    workPackage: WorkPackageDetail
    openTask: (ref: string) => void
    busy: string
    mutate: (label: string, action: () => Promise<unknown>) => Promise<void>
    openNote: (path: string) => void
    notesChanged: () => void
}) {
    const ready = () =>
        props.workPackage.tasks.filter((task) => task.status === "dev_complete")
            .length
    const closeable = () =>
        props.workPackage.tasks.filter(
            (task) =>
                task.status === "dev_complete" || task.status === "verified",
        ).length
    return (
        <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
            <section>
                <div class="mb-4 flex items-center justify-between">
                    <h2 class="section-title">Tasks</h2>
                    <span class="text-sm text-slate-500">
                        {props.workPackage.openCount} open ·{" "}
                        {props.workPackage.taskCount} total
                    </span>
                </div>
                <div class="task-list">
                    <For
                        each={props.workPackage.tasks}
                        fallback={
                            <p class="p-10 text-center text-sm text-slate-400">
                                This work package has no tasks yet.
                            </p>
                        }
                    >
                        {(task, index) => (
                            <TaskRow
                                task={task}
                                index={index()}
                                onClick={() => props.openTask(task.ref)}
                            />
                        )}
                    </For>
                </div>
                <Show when={props.workPackage.outsideBlockers.length}>
                    <p class="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">
                        This work package is waiting on{" "}
                        {props.workPackage.outsideBlockers
                            .map((task) => task.ref)
                            .join(", ")}{" "}
                        from outside the work package.
                    </p>
                </Show>
            </section>
            <aside class="space-y-5">
                <InfoCard title="Next up">
                    <Show
                        when={nextWorkableTask(props.workPackage)}
                        fallback={
                            <p class="text-sm text-slate-500">
                                Nothing is currently ready to start.
                            </p>
                        }
                    >
                        {(task) => (
                            <button
                                class="w-full text-left"
                                onClick={() => props.openTask(task().ref)}
                            >
                                <span class="font-mono text-xs text-slate-400">
                                    {task().ref}
                                </span>
                                <strong class="mt-1 block text-sm">
                                    {task().title}
                                </strong>
                            </button>
                        )}
                    </Show>
                </InfoCard>
                <InfoCard title="Reference notes">
                    <AttachedNotes
                        notes={props.workPackage.notes}
                        attach={(path) =>
                            api.attachWorkPackageNote(
                                props.workPackage.ref,
                                path,
                            )
                        }
                        detach={(path) =>
                            api.detachWorkPackageNote(
                                props.workPackage.ref,
                                path,
                            )
                        }
                        changed={props.notesChanged}
                        open={props.openNote}
                    />
                </InfoCard>
                <Show when={props.workPackage.run}>
                    {(run) => (
                        <InfoCard title="Latest work package run">
                            <div class="flex items-center justify-between">
                                <span class="text-sm font-medium">
                                    {
                                        WORK_PACKAGE_RUN_STATUS_LABELS[
                                            run().status
                                        ]
                                    }
                                </span>
                                <span class="text-xs text-slate-400">
                                    {run().worked.length} finished
                                </span>
                            </div>
                            <Show when={run().stopReason}>
                                <p class="mt-2 text-xs leading-5 text-slate-500">
                                    {run().stopReason}
                                </p>
                            </Show>
                        </InfoCard>
                    )}
                </Show>
                <InfoCard title="Sign off">
                    <p class="mb-3 text-xs leading-5 text-slate-500">
                        Apply review decisions to every eligible task in this
                        work package.
                    </p>
                    <div class="grid gap-2">
                        <button
                            class="button"
                            disabled={!ready() || !!props.busy}
                            onClick={() =>
                                props.mutate("verify", () =>
                                    api.advanceWorkPackage(
                                        props.workPackage.ref,
                                        "verified",
                                    ),
                                )
                            }
                        >
                            Verify all ({ready()})
                        </button>
                        <button
                            class="button-primary"
                            disabled={!closeable() || !!props.busy}
                            onClick={() =>
                                confirm(
                                    "Verify and close every eligible task in this work package?",
                                ) &&
                                props.mutate("close", () =>
                                    api.advanceWorkPackage(
                                        props.workPackage.ref,
                                        "closed",
                                    ),
                                )
                            }
                        >
                            Verify and close ({closeable()})
                        </button>
                    </div>
                </InfoCard>
            </aside>
        </div>
    )
}

function TaskRow(props: { task: Task; index: number; onClick: () => void }) {
    return (
        <button
            class="task-row flex w-full items-start gap-4 px-5 py-4 text-left"
            onClick={props.onClick}
        >
            <span class="mt-1 w-5 text-right font-mono text-xs text-slate-300">
                {props.index + 1}
            </span>
            <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-xs font-semibold text-slate-400">
                        {props.task.ref}
                    </span>
                    <StatusBadge status={props.task.status} />
                </div>
                <p class="mt-1.5 truncate text-sm font-medium text-slate-800">
                    {props.task.title}
                </p>
            </div>
            <span class="mt-2 text-xs capitalize text-slate-400">
                {props.task.priority}
            </span>
        </button>
    )
}

function InvestigationPanel(props: {
    investigation?: Investigation
    workPackage: WorkPackageDetail
    changed: () => void
}) {
    const detail = createMemo(async (): Promise<InvestigationDetail | null> =>
        props.investigation
            ? api.getInvestigation(props.investigation.ref)
            : null,
    )
    const [busy, setBusy] = createSignal(false)
    const [error, setError] = createSignal("")
    const [launcherOpen, setLauncherOpen] = createSignal(false)
    const attach = async () => {
        setBusy(true)
        setError("")
        try {
            await api.ensureWorkPackageInvestigation(
                props.workPackage.ref,
                props.workPackage.description,
            )
            props.changed()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    return (
        <section class="mx-auto max-w-4xl">
            <div class="investigation-heading">
                <div>
                    <h2>Investigation</h2>
                    <p>
                        The brief is the question an agent will research before
                        it creates work.
                    </p>
                </div>
            </div>
            <Show
                when={props.investigation}
                fallback={
                    <div class="investigation-setup">
                        <h3>Add an investigation to this work package</h3>
                        <p>
                            This is an older work package. Its current
                            description can become the investigation brief,
                            without moving or changing any existing tasks.
                        </p>
                        <button
                            class="button-primary"
                            disabled={busy()}
                            onClick={attach}
                        >
                            {busy()
                                ? "Setting up…"
                                : "Use description as investigation"}
                        </button>
                        <Show when={error()}>
                            <p class="banner mt-4">{error()}</p>
                        </Show>
                    </div>
                }
            >
                <Loading fallback={<PageSkeleton compact />}>
                    <Show when={detail()} keyed>
                        {(investigation) => (
                            <>
                                <div class="investigation-flow">
                                    <div class="flow-step flow-step-current">
                                        <span>1</span>
                                        <strong>Brief</strong>
                                        <small>Define the question</small>
                                    </div>
                                    <div
                                        class={`flow-step ${investigation.status !== "draft" ? "flow-step-current" : ""}`}
                                    >
                                        <span>2</span>
                                        <strong>Investigate</strong>
                                        <small>Agent researches</small>
                                    </div>
                                    <div
                                        class={`flow-step ${investigation.status === "complete" ? "flow-step-current" : ""}`}
                                    >
                                        <span>3</span>
                                        <strong>Tasks</strong>
                                        <small>Work lands here</small>
                                    </div>
                                </div>
                                <div class="investigation-panel">
                                    <header>
                                        <div>
                                            <span>{investigation.ref}</span>
                                            <h3>{props.workPackage.name}</h3>
                                        </div>
                                        <span class="investigation-status">
                                            {
                                                INVESTIGATION_STATUS_LABELS[
                                                    investigation.status
                                                ]
                                            }
                                        </span>
                                    </header>
                                    <InvestigationBrief
                                        investigation={investigation}
                                        saved={() => {
                                            refresh(detail)
                                            props.changed()
                                        }}
                                    />
                                    <div class="investigation-actions">
                                        <div>
                                            <strong>
                                                {investigation.status ===
                                                "complete"
                                                    ? "Investigation complete"
                                                    : "Ready to investigate?"}
                                            </strong>
                                            <p>
                                                {investigation.status ===
                                                "complete"
                                                    ? `${investigation.tasks.length} task(s) were created from this investigation.`
                                                    : "The agent will only research and plan. Product code is changed later by task agents."}
                                            </p>
                                        </div>
                                        <button
                                            class="button-primary"
                                            disabled={
                                                !investigation.brief.trim() ||
                                                investigation.status ===
                                                    "investigating"
                                            }
                                            onClick={() =>
                                                setLauncherOpen(true)
                                            }
                                        >
                                            {investigation.status === "complete"
                                                ? "Run again"
                                                : investigation.status ===
                                                    "investigating"
                                                  ? "Investigation running…"
                                                  : "Run investigation"}
                                        </button>
                                    </div>
                                    <Show when={investigation.findings}>
                                        <div class="investigation-findings">
                                            <h4>Findings</h4>
                                            <p>{investigation.findings}</p>
                                        </div>
                                    </Show>
                                </div>
                                <Show when={launcherOpen()}>
                                    <InvestigationLauncher
                                        investigation={investigation}
                                        close={() => setLauncherOpen(false)}
                                        started={() => {
                                            refresh(detail)
                                            props.changed()
                                        }}
                                    />
                                </Show>
                            </>
                        )}
                    </Show>
                </Loading>
            </Show>
        </section>
    )
}

function InvestigationBrief(props: {
    investigation: InvestigationDetail
    saved: () => void
}) {
    const [brief, setBrief] = createSignal(props.investigation.brief)
    const [busy, setBusy] = createSignal(false)
    const [saved, setSaved] = createSignal(false)
    const [error, setError] = createSignal("")
    const save = async () => {
        setBusy(true)
        setSaved(false)
        setError("")
        try {
            await api.updateInvestigation(props.investigation.ref, {
                brief: brief(),
            })
            props.saved()
            setSaved(true)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy(false)
        }
    }
    return (
        <div class="investigation-brief">
            <label class="field">
                <span>Investigation brief</span>
                <textarea
                    value={brief()}
                    onInput={(event) => {
                        setBrief(event.currentTarget.value)
                        setSaved(false)
                    }}
                    placeholder="Describe what the agent should investigate, where to start, and what a useful answer should cover."
                />
            </label>
            <Show when={error()}>
                <p class="banner mt-4">{error()}</p>
            </Show>
            <div>
                <span>
                    {saved() ? "Saved" : `${brief().length} characters`}
                </span>
                <button
                    class="button"
                    disabled={busy() || brief() === props.investigation.brief}
                    onClick={save}
                >
                    {busy() ? "Saving…" : "Save brief"}
                </button>
            </div>
        </div>
    )
}

function BranchPanel(props: {
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
    const [busy, setBusy] = createSignal("")
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

    const run = async (
        label: string,
        action: () => Promise<CombinedBranchDetail>,
        message: string,
    ) => {
        setBusy(label)
        setError("")
        setNotice("")
        try {
            applyBranch(await action())
            setNotice(message)
            props.changed()
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy("")
        }
    }
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
            )
    }
    const openPr = async (draft: boolean) => {
        const branch = current()
        if (!branch) return
        setBusy("pr")
        setError("")
        setNotice("")
        try {
            let latest = branch
            if (descriptionDirty())
                latest = await api.updateBranch(branch.branchName, {
                    prTitle: title(),
                    prBody: body(),
                })
            const result = await api.createPr(latest.branchName, draft)
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
            setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
            setBusy("")
        }
    }
    const saveBranchName = async () => {
        const next = branchName().trim()
        if (!next || next === props.workPackage.branchName) return
        setBusy("branch-name")
        setError("")
        setNotice("")
        try {
            await api.updateWorkPackage(props.workPackage.ref, {
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
        } finally {
            setBusy("")
        }
    }
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
        <section class="branch-workspace mx-auto max-w-4xl">
            <div class="branch-heading">
                <div>
                    <h2>Delivery branch</h2>
                    <code>{props.workPackage.branchName}</code>
                    <span>
                        from <code>{props.workPackage.baseBranch}</code>
                    </span>
                </div>
                <span
                    class={`branch-state ${props.workPackage.git.exists ? "branch-state-ready" : ""}`}
                >
                    {props.workPackage.git.exists
                        ? "Local branch ready"
                        : "Not created yet"}
                </span>
            </div>

            <Show when={error()}>
                <p class="banner">{error()}</p>
            </Show>
            <Show when={notice()}>
                <p class="branch-notice" role="status">
                    {notice()}
                </p>
            </Show>

            <BranchSection
                variant="tonal"
                title="Local branch name"
                description="Rename the local delivery branch while preserving its commit history."
            >
                <div class="branch-name-editor">
                    <input
                        aria-label="Local delivery branch name"
                        class="branch-name-input"
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
                        class="button"
                        disabled={
                            !!busy() ||
                            !branchName().trim() ||
                            branchName().trim() === props.workPackage.branchName
                        }
                        onClick={() => void saveBranchName()}
                    >
                        {busy() === "branch-name"
                            ? "Renaming…"
                            : "Rename local branch"}
                    </button>
                </div>
                <p class="branch-name-help">
                    If the branch has not been created yet, this only sets the
                    name it will use when first created.
                </p>
                <Show when={current()} keyed>
                    {(branch) => (
                        <>
                            <div class="branch-name-editor">
                                <input
                                    aria-label="Remote branch name"
                                    class="branch-name-input"
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
                                    class="button"
                                    disabled={
                                        !!busy() ||
                                        remoteBranch().trim() ===
                                            (branch.remoteBranch ?? "")
                                    }
                                    onClick={() => void saveRemoteBranch()}
                                >
                                    {busy() === "remote-branch"
                                        ? "Saving…"
                                        : "Save remote branch"}
                                </button>
                            </div>
                            <p class="branch-name-help">
                                Leave this blank to push under the local branch
                                name. Changing it does not rename or move the
                                local branch.
                            </p>
                        </>
                    )}
                </Show>
            </BranchSection>

            <BranchSection
                variant="elevated"
                title="Contents"
                description="The commits currently unique to this work package branch."
            >
                <div class="branch-metrics">
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
                        <p class="branch-empty">
                            No commits have landed on this branch yet.
                        </p>
                    }
                >
                    <ul class="branch-commits">
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
                    <div class="branch-section branch-unavailable">
                        <h3>Pull request description and checks</h3>
                        <p>
                            These controls become available once the branch has
                            commits that are not on its base branch.
                        </p>
                    </div>
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
                            <div class="branch-section-actions">
                                <button
                                    class="button"
                                    disabled={
                                        !!busy() ||
                                        !branch.git.commits.length ||
                                        !props.tools.prAgentAvailable
                                    }
                                    onClick={generate}
                                >
                                    {busy() === "describe"
                                        ? `Asking ${props.tools.prAgent ?? "the PR agent"}…`
                                        : branch.prTitle
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
                                <p class="branch-warning">
                                    The configured PR-description agent is
                                    unavailable. You can still write the
                                    description manually.
                                </p>
                            </Show>
                            <div
                                class="description-modes"
                                role="group"
                                aria-label="Description view"
                            >
                                <button
                                    class={mode() === "write" ? "active" : ""}
                                    onClick={() => setMode("write")}
                                >
                                    Write
                                </button>
                                <button
                                    class={mode() === "preview" ? "active" : ""}
                                    onClick={() => setMode("preview")}
                                >
                                    Preview
                                </button>
                            </div>
                            <Show
                                when={mode() === "write"}
                                fallback={
                                    <div class="branch-preview markdown">
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
                                    </div>
                                }
                            >
                                <div class="branch-description-fields">
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
                            <div class="branch-footer">
                                <button
                                    class="button"
                                    disabled={!!busy() || !descriptionDirty()}
                                    onClick={save}
                                >
                                    {busy() === "save"
                                        ? "Saving…"
                                        : descriptionDirty()
                                          ? "Save description"
                                          : "Saved"}
                                </button>
                            </div>
                        </BranchSection>

                        <BranchSection
                            variant="tonal"
                            title="Checks"
                            description={`${props.tools.checkCount} configured command(s) · typecheck, lint and tests.`}
                        >
                            <div class="branch-section-actions">
                                <button
                                    class="button"
                                    disabled={
                                        !!busy() ||
                                        !!branch.checksRunning ||
                                        !branch.git.exists ||
                                        props.tools.checkCount === 0
                                    }
                                    onClick={() => runChecks()}
                                >
                                    {busy() === "checks" || branch.checksRunning
                                        ? "Running checks…"
                                        : report()
                                          ? "Run all again"
                                          : "Run all checks"}
                                </button>
                            </div>
                            <Show when={branch.checksRunning}>
                                {(progress) => (
                                    <p class="branch-progress" role="status">
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
                                <p class="branch-empty">
                                    No pre-PR checks are configured for this
                                    repository.
                                </p>
                            </Show>
                            <Show
                                when={
                                    props.tools.checkCount > 0 &&
                                    !branch.checksRunning &&
                                    !report()
                                }
                            >
                                <div>
                                    <p class="branch-empty">
                                        Checks have not been run on this branch
                                        yet.
                                    </p>
                                    <ul class="branch-checks">
                                        <For each={props.tools.checkNames}>
                                            {(check) => (
                                                <li class="check-row check-not-run-row">
                                                    <span class="check-result check-not-run">
                                                        Not run
                                                    </span>
                                                    <strong>{check}</strong>
                                                    <button
                                                        class="button check-run-button"
                                                        disabled={
                                                            !!busy() ||
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
                                    <div class="check-report">
                                        <div class="check-summary">
                                            <span
                                                class={`check-result ${checks().passed ? "check-passed" : "check-failed"}`}
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
                                                    class="button check-agent-button"
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
                                            <p class="branch-warning">
                                                The branch has new commits since
                                                this report was produced, so
                                                these results are stale.
                                            </p>
                                        </Show>
                                        <ul class="branch-checks">
                                            <For each={checks().checks}>
                                                {(check) => (
                                                    <li class="check-row">
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
                                                                    class={`check-result check-${check.status}`}
                                                                >
                                                                    {
                                                                        checkLabel[
                                                                            check
                                                                                .status
                                                                        ]
                                                                    }
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
                                                            class="button check-run-button"
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
                                                    <li class="check-row check-not-run-row">
                                                        <span class="check-result check-not-run">
                                                            Not run
                                                        </span>
                                                        <strong>{check}</strong>
                                                        <button
                                                            class="button check-run-button"
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
                                    <div class="pull-request-step">
                                        <Show when={checksBlocking()}>
                                            {(reason) => (
                                                <p class="branch-step-note">
                                                    {reason()}
                                                </p>
                                            )}
                                        </Show>
                                        <Show when={!title().trim()}>
                                            <p class="branch-step-note">
                                                Add a pull request title before
                                                opening it.
                                            </p>
                                        </Show>
                                        <div class="branch-pr-actions">
                                            <button
                                                class="button"
                                                disabled={
                                                    !!busy() ||
                                                    !title().trim() ||
                                                    !branch.git.exists ||
                                                    !!checksBlocking()
                                                }
                                                onClick={() => openPr(true)}
                                            >
                                                {busy() === "pr"
                                                    ? "Opening…"
                                                    : "Open as draft"}
                                            </button>
                                            <button
                                                class="button-primary"
                                                disabled={
                                                    !!busy() ||
                                                    !title().trim() ||
                                                    !branch.git.exists ||
                                                    !!checksBlocking()
                                                }
                                                onClick={() => openPr(false)}
                                            >
                                                {busy() === "pr"
                                                    ? "Opening…"
                                                    : "Open pull request"}
                                            </button>
                                        </div>
                                    </div>
                                }
                            >
                                <div class="pull-request-open">
                                    <span>Pull request opened</span>
                                    <a
                                        class="button-primary"
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
        <section
            class={`branch-section branch-section-${props.variant ?? "elevated"}`}
        >
            <header>
                <div>
                    <h3>{props.title}</h3>
                    <p>{props.description}</p>
                </div>
            </header>
            <div class="branch-section-body">{props.children}</div>
        </section>
    )
}

function Metric(props: { label: string; value: string | number }) {
    return (
        <div class="rounded-xl bg-slate-50 p-4">
            <strong class="block text-xl">{props.value}</strong>
            <span class="text-xs text-slate-500">{props.label}</span>
        </div>
    )
}

function LegacyWorkPackage(props: {
    tasks: Task[]
    back: () => void
    openTask: (ref: string) => void
}) {
    return (
        <div class="mx-auto max-w-5xl px-5 py-8 sm:px-8">
            <button
                class="mb-5 text-sm font-medium text-slate-500"
                onClick={props.back}
            >
                ← All work packages
            </button>
            <div class="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                <h1 class="text-2xl font-semibold">Unassigned</h1>
                <p class="mt-2 text-sm text-amber-800">
                    These are legacy records. They remain available, but new
                    tasks cannot be added here. Move each task into a real work
                    package when convenient.
                </p>
            </div>
            <div class="mt-6 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200">
                <For each={props.tasks}>
                    {(task, index) => (
                        <TaskRow
                            task={task}
                            index={index()}
                            onClick={() => props.openTask(task.ref)}
                        />
                    )}
                </For>
            </div>
        </div>
    )
}
