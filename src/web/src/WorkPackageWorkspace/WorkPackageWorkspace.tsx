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
                                <div class="workspace-topbar flex min-h-[3.6rem] items-center gap-[0.8rem] p-[0_clamp(1.25rem,_3vw,_2.5rem)]">
                                    <Brand compact />
                                    <span class="topbar-divider w-px h-[1rem]" />
                                    <span>{detail.name}</span>
                                </div>
                                <div class="mx-auto max-w-[1600px] px-5 pb-0 pt-5 sm:px-8">
                                    <button
                                        class="back-link inline-flex items-center gap-[0.35rem]"
                                        onClick={props.back}
                                    >
                                        <BackIcon />
                                        All work packages
                                    </button>
                                    <div class="mt-5 flex flex-wrap items-end justify-between gap-5">
                                        <div>
                                            <div class="work-package-context flex items-center gap-[0.5rem] [&>span:first-child]:w-[0.65rem] [&>span:first-child]:h-[0.65rem]">
                                                <span
                                                    style={{
                                                        background:
                                                            detail.color,
                                                    }}
                                                />
                                                <span>{detail.ref}</span>
                                            </div>
                                            <h1 class="workspace-title m-[0.55rem_0_0]">
                                                {detail.name}
                                            </h1>
                                            <p class="workspace-description max-w-[70ch] m-[0.8rem_0_0]">
                                                {detail.description ||
                                                    "Add a description to define the outcome for this work package."}
                                            </p>
                                        </div>
                                        <div class="flex flex-wrap items-center justify-end gap-2">
                                            <button
                                                class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                                        class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                                    class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                    <nav class="workspace-tabs flex gap-[1.5rem] mt-[2rem] max-[560px]:gap-[1rem]">
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
                                    <p class="banner mb-5 p-[0.8rem_1rem]">
                                        {error()}
                                    </p>
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
            class={`workspace-tab ${props.active ? "workspace-tab-active" : ""} relative min-h-[2.75rem] after:absolute after:right-0 after:bottom-[-1px] after:left-0 after:h-[2px]`}
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
                            class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                            class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
            <div class="investigation-heading flex items-end justify-between mb-[1rem] [&_h2]:m-0 [&_p]:m-[0.3rem_0_0]">
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
                    <div class="investigation-setup p-[clamp(1.25rem,_3vw,_2rem)] [&_h3]:m-0 [&>p]:max-w-[65ch] [&>p]:m-[0.55rem_0_1.1rem]">
                        <h3>Add an investigation to this work package</h3>
                        <p>
                            This is an older work package. Its current
                            description can become the investigation brief,
                            without moving or changing any existing tasks.
                        </p>
                        <button
                            class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
                            disabled={busy()}
                            onClick={attach}
                        >
                            {busy()
                                ? "Setting up…"
                                : "Use description as investigation"}
                        </button>
                        <Show when={error()}>
                            <p class="banner mt-4 p-[0.8rem_1rem]">{error()}</p>
                        </Show>
                    </div>
                }
            >
                <Loading fallback={<PageSkeleton compact />}>
                    <Show when={detail()} keyed>
                        {(investigation) => (
                            <>
                                <div class="investigation-flow grid grid-cols-[repeat(3,_minmax(0,_1fr))] mb-[1rem] max-[560px]:grid-cols-[1fr]">
                                    <div class="flow-step flow-step-current relative grid grid-cols-[1.6rem_1fr] gap-[0.15rem_0.65rem] p-[0.85rem_1rem] [&>span]:row-[1_/_3] [&>span]:grid [&>span]:w-[1.55rem] [&>span]:h-[1.55rem] [&>span]:place-items-center [&_strong]:self-end">
                                        <span>1</span>
                                        <strong>Brief</strong>
                                        <small>Define the question</small>
                                    </div>
                                    <div
                                        class={`flow-step ${investigation.status !== "draft" ? "flow-step-current" : ""} relative grid grid-cols-[1.6rem_1fr] gap-[0.15rem_0.65rem] p-[0.85rem_1rem] [&>span]:row-[1_/_3] [&>span]:grid [&>span]:w-[1.55rem] [&>span]:h-[1.55rem] [&>span]:place-items-center [&_strong]:self-end`}
                                    >
                                        <span>2</span>
                                        <strong>Investigate</strong>
                                        <small>Agent researches</small>
                                    </div>
                                    <div
                                        class={`flow-step ${investigation.status === "complete" ? "flow-step-current" : ""} relative grid grid-cols-[1.6rem_1fr] gap-[0.15rem_0.65rem] p-[0.85rem_1rem] [&>span]:row-[1_/_3] [&>span]:grid [&>span]:w-[1.55rem] [&>span]:h-[1.55rem] [&>span]:place-items-center [&_strong]:self-end`}
                                    >
                                        <span>3</span>
                                        <strong>Tasks</strong>
                                        <small>Work lands here</small>
                                    </div>
                                </div>
                                <div class="investigation-panel [&>header]:flex [&>header]:items-start [&>header]:justify-between [&>header]:gap-[1rem] [&>header]:p-[1.25rem_1.5rem] [&>header_h3]:m-[0.3rem_0_0]">
                                    <header>
                                        <div>
                                            <span>{investigation.ref}</span>
                                            <h3>{props.workPackage.name}</h3>
                                        </div>
                                        <span class="investigation-status p-[0.2rem_0.55rem]">
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
                                    <div class="investigation-actions flex items-center justify-between gap-[1.5rem] p-[1.2rem_1.5rem] [&_p]:max-w-[62ch] [&_p]:m-[0.25rem_0_0] max-[560px]:block max-[560px]:[&_.button-primary]:mt-[1rem]">
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
                                            class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                        <div class="investigation-findings p-[1.5rem] [&_h4]:m-0 [&_p]:m-[0.65rem_0_0]">
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
        <div class="investigation-brief p-[1.5rem] [&_textarea]:min-h-[13rem] [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-[1rem] [&>div]:mt-[0.75rem]">
            <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
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
                <p class="banner mt-4 p-[0.8rem_1rem]">{error()}</p>
            </Show>
            <div>
                <span>
                    {saved() ? "Saved" : `${brief().length} characters`}
                </span>
                <button
                    class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                    class={`branch-state ${props.workPackage.git.exists ? "branch-state-ready" : ""} p-[0.3rem_0.7rem] max-[560px]:inline-block max-[560px]:mt-[0.8rem]`}
                >
                    {props.workPackage.git.exists
                        ? "Local branch ready"
                        : "Not created yet"}
                </span>
            </div>

            <Show when={error()}>
                <p class="banner p-[0.8rem_1rem]">{error()}</p>
            </Show>
            <Show when={notice()}>
                <p class="branch-notice m-0 p-[0.8rem_1rem]" role="status">
                    {notice()}
                </p>
            </Show>

            <BranchSection
                variant="tonal"
                title="Branch name"
                description="Rename the local delivery branch while preserving its commit history."
            >
                <div class="grid grid-cols-[1fr_250px] gap-x-3 gap-y-1">
                    <label
                        class="field-label col-start-1"
                        for="local-branch-name-input"
                    >
                        Local Branch Name
                    </label>
                    <input
                        id="local-branch-name-input"
                        aria-label="Local delivery branch name"
                        class="branch-name-input col-start-1 min-w-0 flex-[1_1_18rem] p-[0.6rem_0.7rem]"
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
                        class="button col-start-2 inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                <Show when={current()} keyed>
                    {(branch) => (
                        <>
                            <div class="grid grid-cols-[1fr_250px] gap-x-3 gap-y-1 mt-4">
                                <label
                                    class="field-label col-start-1"
                                    for="remote-branch-name-input"
                                >
                                    Remote Branch Name
                                </label>
                                <input
                                    id="remote-branch-name-input"
                                    aria-label="Remote branch name"
                                    class="branch-name-input col-start-1 min-w-0 flex-[1_1_18rem] p-[0.6rem_0.7rem]"
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
                                    class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                        <p class="branch-empty m-[1rem_0_0]">
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
                    <div class="branch-section branch-unavailable overflow-hidden [&>header]:p-[1.15rem_1.25rem_0.35rem] [&>header_h3]:m-0 [&>header_p]:m-[0.28rem_0_0] [&_h3]:m-0 [&_p]:m-[0.28rem_0_0] p-[1.25rem]">
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
                            <div class="branch-section-actions flex flex-wrap items-center gap-[0.75rem]">
                                <button
                                    class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                <p class="branch-warning m-[1rem_0_0] p-[0.65rem_0.8rem]">
                                    The configured PR-description agent is
                                    unavailable. You can still write the
                                    description manually.
                                </p>
                            </Show>
                            <div
                                class="description-modes inline-flex gap-[0.2rem] m-[1rem_0_0.75rem] p-[0.2rem] [&_button]:p-[0.38rem_0.7rem]"
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
                                    <div class="branch-preview markdown [&>:first-child]:mt-0 [&_h1]:m-[1.5em_0_0.55em] [&_h2]:m-[1.5em_0_0.55em] [&_h3]:m-[1.5em_0_0.55em] [&_h4]:m-[1.5em_0_0.55em] [&_p]:m-[0_0_1em] [&_code]:p-[0.1rem_0.32rem] [&_pre]:overflow-x-auto [&_pre]:p-[1rem] [&_pre_code]:p-0 [&_blockquote]:m-[0_0_1em] [&_blockquote]:pl-[1rem] [&_ul]:m-[0_0_1em] [&_ul]:pl-[1.5rem] [&_ol]:m-[0_0_1em] [&_ol]:pl-[1.5rem] [&_li.md-task]:ml-[-1.25rem] [&_li.md-task_input]:w-auto [&_li.md-task_input]:mr-[0.5rem] [&_img]:block [&_img]:max-w-full [&_img]:h-auto [&_img]:m-[1rem_0] [&_hr]:m-[1.5em_0] [&_.md-table-wrap]:overflow-x-auto [&_.md-table-wrap]:mb-[1em] [&_table]:min-w-full [&_th]:p-[0.45rem_0.7rem] [&_td]:p-[0.45rem_0.7rem] grid gap-[1rem] min-h-[10rem] p-[1rem] [&>div>:first-child]:mt-0 [&_code]:p-[0.1rem_0.3rem] [&_pre]:p-[0.8rem]">
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
                                <div class="branch-description-fields grid gap-[1rem] [&_textarea]:min-h-[14rem]">
                                    <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
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
                                    <label class="field grid gap-[0.45rem] [&_input]:w-full [&_input]:p-[0.68rem_0.75rem] [&_select]:w-full [&_select]:p-[0.68rem_0.75rem] [&_textarea]:w-full [&_textarea]:p-[0.68rem_0.75rem] [&_textarea]:min-h-[7rem]">
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
                                    class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                            <div class="branch-section-actions flex flex-wrap items-center gap-[0.75rem]">
                                <button
                                    class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                    <p
                                        class="branch-progress m-0 p-[0.8rem_1rem] mt-[1rem]"
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
                                <p class="branch-empty m-[1rem_0_0]">
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
                                    <p class="branch-empty m-[1rem_0_0]">
                                        Checks have not been run on this branch
                                        yet.
                                    </p>
                                    <ul class="branch-checks overflow-hidden m-[1rem_0_0] p-0 [&_.check-row]:flex [&_.check-row]:items-start [&_.check-row_details]:min-w-0 [&_.check-row_details]:flex-1 [&_.check-run-button]:flex-[0_0_auto] [&_.check-run-button]:m-[0.45rem_0.7rem_0.45rem_0] [&_.check-not-run-row]:items-center [&_.check-not-run-row]:gap-[0.7rem] [&_.check-not-run-row]:pl-[0.8rem] [&_.check-not-run-row_strong]:min-w-[7rem] [&_.check-not-run-row_strong]:flex-1 [&_summary]:grid [&_summary]:min-h-[3.4rem] [&_summary]:grid-cols-[auto_minmax(7rem,_1fr)_minmax(10rem,_2fr)_auto] [&_summary]:items-center [&_summary]:gap-[0.7rem] [&_summary]:p-[0.7rem_0.8rem] [&_summary_code]:overflow-hidden [&_details>p]:m-0 [&_details>p]:p-[0_0.8rem_0.7rem] [&_pre]:max-h-[26rem] [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:p-[0.9rem] max-[560px]:[&_summary]:grid-cols-[auto_1fr_auto] max-[560px]:[&_summary_code]:col-[2_/_-1] max-[560px]:[&_summary_code]:row-[2]">
                                        <For each={props.tools.checkNames}>
                                            {(check) => (
                                                <li class="check-row check-not-run-row">
                                                    <span class="check-result check-not-run inline-flex items-center p-[0.18rem_0.5rem]">
                                                        Not run
                                                    </span>
                                                    <strong>{check}</strong>
                                                    <button
                                                        class="button check-run-button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                    <div class="check-report mt-[1rem]">
                                        <div class="check-summary flex flex-wrap items-center gap-[0.75rem]">
                                            <span
                                                class={`check-result ${checks().passed ? "check-passed" : "check-failed"} inline-flex items-center p-[0.18rem_0.5rem]`}
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
                                                    class="button check-agent-button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem] ml-auto max-[560px]:w-full max-[560px]:ml-0"
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
                                            <p class="branch-warning m-[1rem_0_0] p-[0.65rem_0.8rem]">
                                                The branch has new commits since
                                                this report was produced, so
                                                these results are stale.
                                            </p>
                                        </Show>
                                        <ul class="branch-checks overflow-hidden m-[1rem_0_0] p-0 [&_.check-row]:flex [&_.check-row]:items-start [&_.check-row_details]:min-w-0 [&_.check-row_details]:flex-1 [&_.check-run-button]:flex-[0_0_auto] [&_.check-run-button]:m-[0.45rem_0.7rem_0.45rem_0] [&_.check-not-run-row]:items-center [&_.check-not-run-row]:gap-[0.7rem] [&_.check-not-run-row]:pl-[0.8rem] [&_.check-not-run-row_strong]:min-w-[7rem] [&_.check-not-run-row_strong]:flex-1 [&_summary]:grid [&_summary]:min-h-[3.4rem] [&_summary]:grid-cols-[auto_minmax(7rem,_1fr)_minmax(10rem,_2fr)_auto] [&_summary]:items-center [&_summary]:gap-[0.7rem] [&_summary]:p-[0.7rem_0.8rem] [&_summary_code]:overflow-hidden [&_details>p]:m-0 [&_details>p]:p-[0_0.8rem_0.7rem] [&_pre]:max-h-[26rem] [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:p-[0.9rem] max-[560px]:[&_summary]:grid-cols-[auto_1fr_auto] max-[560px]:[&_summary_code]:col-[2_/_-1] max-[560px]:[&_summary_code]:row-[2]">
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
                                                                    class={`check-result check-${check.status} inline-flex items-center p-[0.18rem_0.5rem]`}
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
                                                            class="button check-run-button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                                        <span class="check-result check-not-run inline-flex items-center p-[0.18rem_0.5rem]">
                                                            Not run
                                                        </span>
                                                        <strong>{check}</strong>
                                                        <button
                                                            class="button check-run-button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                                <p class="branch-step-note m-0">
                                                    {reason()}
                                                </p>
                                            )}
                                        </Show>
                                        <Show when={!title().trim()}>
                                            <p class="branch-step-note m-0">
                                                Add a pull request title before
                                                opening it.
                                            </p>
                                        </Show>
                                        <div class="branch-pr-actions flex flex-wrap gap-[0.5rem]">
                                            <button
                                                class="button inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                                class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
                                <div class="pull-request-open flex flex-wrap items-center justify-between gap-[1rem]">
                                    <span>Pull request opened</span>
                                    <a
                                        class="button-primary inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem]"
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
            class={`branch-section branch-section-${props.variant ?? "elevated"} overflow-hidden [&>header]:p-[1.15rem_1.25rem_0.35rem] [&>header_h3]:m-0 [&>header_p]:m-[0.28rem_0_0]`}
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
