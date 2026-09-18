import { useTabs } from "../hooks/useTabs"
import { useDialog } from "../hooks/useDialog"
import {
    workPackageRunActive,
    type Task,
    type WorkPackageBranchDetail,
    type WorkPackageDetail,
} from "@shared/types"
import {
    action,
    createOptimistic,
    For,
    Loading,
    Show,
    createEffect,
    createMemo,
    refresh,
} from "solid-js"
import { AgentLauncher } from "../AgentLauncher/AgentLauncher"
import { CreateTask } from "../CreateTask/CreateTask"
import { InvestigationLauncher } from "../InvestigationLauncher/InvestigationLauncher"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { Brand } from "../components/Brand"
import { PageSkeleton } from "../components/PageSkeleton"
import {
    BackIcon,
    BranchIcon,
    InvestigationIcon,
    PlusIcon,
    RunIcon,
    TasksIcon,
} from "../components/icons"
import type { WorkspaceSnapshot } from "../types/workspace"
import { UNASSIGNED_REF } from "../utils/workPackages"
import { AddBranchDialog } from "./AddBranchDialog"
import { AddTabMenu, type NewTabKind } from "./AddTabMenu"
import { BranchPanel } from "./BranchPanel"
import { InvestigationPanel } from "./InvestigationPanel"
import { LegacyWorkPackage } from "./LegacyWorkPackage"
import { RunPanel } from "./RunPanel"
import { WorkPackageOverview } from "./WorkPackageOverview"
import {
    TASKS_TAB,
    branchTab,
    investigationTab,
    runTab,
    workPackageTabs,
} from "./workPackageTabs"
import styles from "./WorkPackageWorkspace.module.css"

const TAB_KINDS = {
    investigation: { label: "Investigation", Icon: InvestigationIcon },
    branch: { label: "Branch", Icon: BranchIcon },
    run: { label: "Run", Icon: RunIcon },
} as const

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
    const { capture, clear, Banner } = useError()
    const [busy, setBusy] = createOptimistic("")
    const tabs = createMemo(() => {
        const detail = workPackage()
        return detail ? workPackageTabs(detail) : []
    })
    const {
        activeTab,
        setActiveTab: setTab,
        matches,
        tabProps,
        windowProps,
    } = useTabs<string>(() => {
        const detail = workPackage()
        if (!detail || detail.tasks.length) return TASKS_TAB
        return tabs()[0]?.key ?? TASKS_TAB
    })
    // A removed tab cannot stay selected; the Tasks tab is always there.
    createEffect(
        () =>
            activeTab() !== TASKS_TAB &&
            !tabs().some((tab) => tab.key === activeTab()),
        (missing) => {
            if (missing) setTab(TASKS_TAB)
        },
    )
    const changed = () => {
        refresh(workPackage)
        props.changed()
    }
    const { openDialog: openAddBranch } = useDialog(({ closeDialog }) => (
        <Show when={workPackage()} keyed>
            {(detail) => (
                <AddBranchDialog
                    workPackage={detail}
                    snapshot={props.snapshot}
                    close={closeDialog}
                    created={(id) => {
                        closeDialog()
                        changed()
                        setTab(branchTab(id))
                    }}
                />
            )}
        </Show>
    ))
    const addInvestigation = action(async function* () {
        const detail = workPackage()
        if (busy() || !detail) return
        setBusy("add-tab")
        clear()
        try {
            const count = detail.investigations.length
            const result = await api.addWorkPackageInvestigation(detail.ref, {
                title: count ? `Investigation ${count + 1}` : detail.name,
            })
            yield
            changed()
            setTab(investigationTab(result.investigation.ref))
        } catch (caught) {
            yield
            capture(caught)
        }
    })
    const addTab = (kind: NewTabKind) => {
        if (kind === "investigation") void addInvestigation()
        if (kind === "branch") openAddBranch()
        if (kind === "run") openAgent()
    }
    const { openDialog: openAgent } = useDialog(({ closeDialog }) => (
        <Show when={workPackage()} keyed>
            {(detail) => (
                <AgentLauncher
                    workPackage={detail}
                    close={closeDialog}
                    finished={changed}
                    started={(id) => setTab(runTab(id))}
                />
            )}
        </Show>
    ))
    const { openDialog: openCreateTask } = useDialog(({ closeDialog }) => (
        <Show when={workPackage()} keyed>
            {(detail) => (
                <CreateTask
                    workPackage={detail}
                    close={closeDialog}
                    created={(ref) => {
                        closeDialog()
                        changed()
                        props.openTask(ref)
                    }}
                />
            )}
        </Show>
    ))
    const { openDialog: openInvestigation } = useDialog(({ closeDialog }) => (
        <Show
            when={workPackage()?.investigations.find(
                (item) => item.status !== "complete",
            )}
            keyed>
            {(item) => (
                <InvestigationLauncher
                    investigation={item}
                    close={closeDialog}
                    started={changed}
                />
            )}
        </Show>
    ))

    createEffect(
        () => props.revision,
        () => {
            void refresh(workPackage)
        },
    )

    const loose = () =>
        props.snapshot.tasks.filter((task) => !task.workPackageRef)
    const mutate = action(function* (
        label: string,
        request: () => Promise<unknown>,
    ) {
        if (busy()) return

        setBusy(label)
        clear()
        try {
            yield request()

            yield refresh(workPackage)
            props.changed()
        } catch (caught) {
            capture(caught)
        }
    })

    return (
        <main
            class={`${styles.scope} workspace-page min-h-screen text-slate-950`}>
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
                    const investigation = (ref: string) =>
                        detail.investigations.find((item) => item.ref === ref)
                    const branch = (id: number) =>
                        detail.branches.find((item) => item.id === id)
                    const runnable = () =>
                        detail.investigations.find(
                            (item) => item.status !== "complete",
                        )
                    const delivery = (branch: WorkPackageBranchDetail) =>
                        props.snapshot.branches.find(
                            (item) => item.branchName === branch.branchName,
                        ) ??
                        (branch.delivery
                            ? {
                                  ...branch.delivery,
                                  git: branch.git,
                                  tasks: branch.delivery.taskRefs
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
                    return (
                        <>
                            <header class="workspace">
                                <div class="topbar flex min-h-[3.6rem] items-center gap-[0.8rem] p-[0_clamp(1.25rem,_3vw,_2.5rem)]">
                                    <Brand compact />
                                    <span class="topbar-divider w-px h-[1rem]" />
                                    <span>{detail.name}</span>
                                </div>
                                <div class="mx-auto max-w-[1600px] px-5 pb-0 pt-5 sm:px-8">
                                    <button
                                        class="back inline-flex items-center gap-[0.35rem]"
                                        onClick={props.back}>
                                        <BackIcon />
                                        All work packages
                                    </button>
                                    <div class="mt-5 flex flex-wrap items-end justify-between gap-5">
                                        <div>
                                            <div class="reference flex items-center gap-[0.5rem]">
                                                <span
                                                    class="dot w-[0.65rem] h-[0.65rem]"
                                                    style={{
                                                        background:
                                                            detail.color,
                                                    }}
                                                />
                                                <span>{detail.ref}</span>
                                            </div>
                                            <h1 class="headline m-[0.55rem_0_0]">
                                                {detail.name}
                                            </h1>
                                            <Show when={detail.brief}>
                                                <p class="description line-clamp-2 max-w-[70ch] m-[0.8rem_0_0]">
                                                    {detail.brief}
                                                </p>
                                            </Show>
                                        </div>
                                        <div class="flex flex-wrap items-center justify-end gap-2">
                                            <button
                                                class="outlined"
                                                onClick={() =>
                                                    openCreateTask()
                                                }>
                                                <PlusIcon />
                                                Add task
                                            </button>
                                            <Show
                                                when={detail.tasks.length > 0}
                                                fallback={
                                                    <Show when={runnable()}>
                                                        <button
                                                            class="primary"
                                                            onClick={() =>
                                                                openInvestigation()
                                                            }>
                                                            Run investigation
                                                        </button>
                                                    </Show>
                                                }>
                                                <button
                                                    class="primary"
                                                    disabled={
                                                        !detail.queue.length ||
                                                        workPackageRunActive(
                                                            detail.run,
                                                        )
                                                    }
                                                    onClick={() => openAgent()}
                                                    aria-busy={
                                                        workPackageRunActive(
                                                            detail.run,
                                                        )
                                                            ? "true"
                                                            : "false"
                                                    }>
                                                    Work with an agent
                                                </button>
                                            </Show>
                                        </div>
                                    </div>
                                    <div class="mt-[2rem] flex items-end gap-[1.5rem] max-[560px]:gap-[1rem]">
                                        <nav
                                            role="tablist"
                                            aria-label="Work package"
                                            class="underlined flex flex-wrap gap-[1.5rem] max-[560px]:gap-[1rem]">
                                            <button
                                                ref={tabProps(TASKS_TAB)}
                                                class="inline-flex items-center gap-[0.4rem]">
                                                <TasksIcon />
                                                Tasks
                                            </button>
                                            <For each={tabs()}>
                                                {(tab) => {
                                                    const { label, Icon } =
                                                        TAB_KINDS[tab.kind]
                                                    return (
                                                        <button
                                                            ref={tabProps(
                                                                tab.key,
                                                            )}
                                                            class="inline-flex items-center gap-[0.4rem]"
                                                            title={label}>
                                                            <Icon />
                                                            {tab.label}
                                                        </button>
                                                    )
                                                }}
                                            </For>
                                        </nav>
                                        <AddTabMenu
                                            choose={addTab}
                                            busy={busy() === "add-tab"}
                                        />
                                    </div>
                                </div>
                            </header>
                            <div class="mx-auto max-w-[1600px] px-5 py-8 sm:px-8">
                                <Banner />
                                <section {...windowProps(TASKS_TAB)}>
                                    <Show when={matches(TASKS_TAB)}>
                                        <WorkPackageOverview
                                            workPackage={detail}
                                            openTask={props.openTask}
                                            busy={busy()}
                                            mutate={mutate}
                                            openNote={props.openNote}
                                            notesChanged={changed}
                                        />
                                    </Show>
                                </section>
                                <For each={detail.investigations}>
                                    {(item) => (
                                        <section
                                            {...windowProps(
                                                investigationTab(item.ref),
                                            )}>
                                            <Show
                                                when={
                                                    matches(
                                                        investigationTab(
                                                            item.ref,
                                                        ),
                                                    ) && investigation(item.ref)
                                                }
                                                keyed>
                                                {(current) => (
                                                    <InvestigationPanel
                                                        investigation={current}
                                                        workPackage={detail}
                                                        changed={changed}
                                                    />
                                                )}
                                            </Show>
                                        </section>
                                    )}
                                </For>
                                <For each={detail.branches}>
                                    {(item) => (
                                        <section
                                            {...windowProps(
                                                branchTab(item.id),
                                            )}>
                                            <Show
                                                when={
                                                    matches(
                                                        branchTab(item.id),
                                                    ) && branch(item.id)
                                                }
                                                keyed>
                                                {(current) => (
                                                    <BranchPanel
                                                        workPackage={detail}
                                                        branch={current}
                                                        delivery={delivery(
                                                            current,
                                                        )}
                                                        tools={
                                                            props.snapshot.tools
                                                        }
                                                        changed={props.changed}
                                                        workPackageChanged={
                                                            changed
                                                        }
                                                    />
                                                )}
                                            </Show>
                                        </section>
                                    )}
                                </For>
                                <For each={detail.workRuns}>
                                    {(item) => (
                                        <section
                                            {...windowProps(runTab(item.id))}>
                                            <Show
                                                when={
                                                    matches(runTab(item.id)) &&
                                                    detail.workRuns.find(
                                                        (run) =>
                                                            run.id === item.id,
                                                    )
                                                }
                                                keyed>
                                                {(current) => (
                                                    <RunPanel
                                                        workPackage={detail}
                                                        run={current}
                                                        openTask={
                                                            props.openTask
                                                        }
                                                        changed={changed}
                                                    />
                                                )}
                                            </Show>
                                        </section>
                                    )}
                                </For>
                            </div>
                        </>
                    )
                }}
            </Show>
        )
    }
}
