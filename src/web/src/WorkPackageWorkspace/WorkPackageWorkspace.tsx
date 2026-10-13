import { createQuery } from "../hooks/createQuery"
import { useTabs } from "../hooks/useTabs"
import { useDialog } from "../hooks/useDialog"
import {
    workPackageRunActive,
    type GitConflict,
    type Task,
    type WorkPackageBranchDetail,
    type WorkPackageDetail,
    type WorkRunDetail,
} from "@shared/types"
import {
    action,
    createOptimistic,
    For,
    Loading,
    Show,
    createEffect,
    createProjection,
    createSignal,
    refresh,
} from "solid-js"
import { AgentLauncher } from "../AgentLauncher/AgentLauncher"
import { CreateTask } from "../CreateTask/CreateTask"
import { api } from "../api"
import { useError } from "../hooks/useError"
import { Brand } from "../components/Brand"
import { ConflictAgentDialog } from "../components/ConflictAgentDialog"
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
import { PipelineDialog } from "./PipelineDialog"
import { RunPanel } from "./RunPanel"
import { ResumePipelineDialog } from "./ResumePipelineDialog"
import { SupervisorDialog } from "./SupervisorDialog"
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
    changed: () => void
    revision: number
}) {
    const legacy = () => props.workPackageRef === UNASSIGNED_REF
    const workPackage = createQuery(
        async (): Promise<WorkPackageDetail | null> =>
            legacy() ? null : api.getWorkPackage(props.workPackageRef),
    )
    const { capture, clear, Banner } = useError()
    const [busy, setBusy] = createOptimistic("")
    const tabs = createProjection(
        () => {
            const detail = workPackage.value
            return detail ? workPackageTabs(detail) : []
        },
        [],
        { key: "key" },
    )
    const {
        activeTab,
        setActiveTab: setTab,
        matches,
        tabProps,
        windowProps,
    } = useTabs<string>(() => {
        const detail = workPackage.value
        if (!detail || detail.tasks.length) return TASKS_TAB
        return tabs[0]?.key ?? TASKS_TAB
    })
    // A removed tab cannot stay selected; the Tasks tab is always there.
    createEffect(
        () =>
            activeTab() !== TASKS_TAB &&
            !tabs.some((tab) => tab.key === activeTab()),
        (missing) => {
            if (missing) setTab(TASKS_TAB)
        },
    )
    const changed = () => {
        refresh(workPackage)
        props.changed()
    }
    const { openDialog: openAddBranch } = useDialog(({ closeDialog }) => (
        <Show when={workPackage.value} keyed>
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
        const detail = workPackage.value
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
        <Show when={workPackage.value} keyed>
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
    const { openDialog: openPipeline } = useDialog(({ closeDialog }) => (
        <Show when={workPackage.value} keyed>
            {(detail) => (
                <PipelineDialog
                    workPackage={detail}
                    snapshot={props.snapshot}
                    close={closeDialog}
                    changed={changed}
                    started={(id) => setTab(runTab(id))}
                />
            )}
        </Show>
    ))
    // Keep the dialog open even if its originating Run tab is removed.
    let resumedRun: WorkRunDetail | undefined
    const { openDialog: openResumeDialog } = useDialog(({ closeDialog }) => (
        <ResumePipelineDialog
            run={resumedRun!}
            close={closeDialog}
            changed={changed}
        />
    ))
    const resumePipeline = (run: WorkRunDetail) => {
        resumedRun = run
        openResumeDialog()
    }
    let supervisedRun: WorkRunDetail | undefined
    const { openDialog: openSupervisorDialog } = useDialog(
        ({ closeDialog }) => (
            <SupervisorDialog
                workPackageRef={supervisedRun!.workPackageRef}
                run={supervisedRun!}
                close={closeDialog}
                changed={changed}
            />
        ),
    )
    // Conflict resolution also survives switching or removing its branch tab.
    const [notice, setNotice] = createSignal("")
    let conflict: GitConflict | undefined
    const { openDialog: openConflictDialog } = useDialog(({ closeDialog }) => (
        <ConflictAgentDialog
            conflict={conflict!}
            subject={{ kind: "branch", ref: conflict!.branch }}
            close={closeDialog}
            started={(run) =>
                setNotice(
                    run.mode === "terminal"
                        ? `An agent is rebasing ${conflict!.branch} onto ${conflict!.onto} in a terminal window.`
                        : `An agent is rebasing ${conflict!.branch} onto ${conflict!.onto} (run #${run.id}).`,
                )
            }
        />
    ))
    const offerConflict = (found: GitConflict) => {
        conflict = found
        setNotice("")
        openConflictDialog()
    }
    const editSupervisor = (run: WorkRunDetail) => {
        supervisedRun = run
        openSupervisorDialog()
    }
    const { openDialog: openCreateTask } = useDialog(({ closeDialog }) => (
        <Show when={workPackage.value} keyed>
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
            <Show when={props.workPackageRef} keyed>
                {(_ref) => <WorkPackageDetailContent />}
            </Show>
        )
    }

    function WorkPackageDetailContent() {
        return (
            <Show when={workPackage.value}>
                {(detail) => {
                    const investigation = (ref: string) =>
                        detail().investigations.find((item) => item.ref === ref)
                    const branch = (id: number) =>
                        detail().branches.find((item) => item.id === id)
                    // One loop or start-to-finish run at a time: they share
                    // the working tree.
                    const working = () =>
                        workPackageRunActive(detail().run) ||
                        detail().workRuns.some(
                            (run) =>
                                run.kind === "pipeline" &&
                                run.status === "running",
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
                                          detail().tasks.find(
                                              (task) => task.ref === ref,
                                          ),
                                      )
                                      .filter(
                                          (task): task is Task =>
                                              task !== undefined,
                                      ),
                                  checksRunning: null,
                                  checksSupervision: null,
                              }
                            : undefined)
                    return (
                        <>
                            <header class="workspace">
                                <div class="topbar flex min-h-[3.6rem] items-center gap-[0.8rem] p-[0_clamp(1.25rem,_3vw,_2.5rem)]">
                                    <Brand compact />
                                    <span class="topbar-divider w-px h-[1rem]" />
                                    <span>{detail().name}</span>
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
                                                            detail().color,
                                                    }}
                                                />
                                                <span>{detail().ref}</span>
                                            </div>
                                            <h1 class="headline m-[0.55rem_0_0]">
                                                {detail().name}
                                            </h1>
                                            <Show when={detail().brief}>
                                                <p class="description line-clamp-2 max-w-[70ch] m-[0.8rem_0_0]">
                                                    {detail().brief}
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
                                            <button
                                                class="primary"
                                                disabled={working()}
                                                onClick={() => openPipeline()}
                                                aria-busy={
                                                    working() ? "true" : "false"
                                                }
                                                title={
                                                    working()
                                                        ? "An agent is already working through a work package."
                                                        : "Investigate, work the tasks, and deliver each branch as a pull request"
                                                }>
                                                Work with an agent
                                            </button>
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
                                            <For each={tabs}>
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
                                <Show when={notice()}>
                                    <p
                                        class="notice success m-[0_0_1rem]"
                                        role="status">
                                        {notice()}
                                    </p>
                                </Show>
                                <section {...windowProps(TASKS_TAB)}>
                                    <Show when={matches(TASKS_TAB)}>
                                        <WorkPackageOverview
                                            workPackage={detail()}
                                            openTask={props.openTask}
                                            busy={busy()}
                                            mutate={mutate}
                                        />
                                    </Show>
                                </section>
                                <For each={detail().investigations}>
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
                                                        workPackage={detail()}
                                                        changed={changed}
                                                        revision={
                                                            props.revision
                                                        }
                                                    />
                                                )}
                                            </Show>
                                        </section>
                                    )}
                                </For>
                                <For
                                    each={detail().branches}
                                    keyed={(item) => item.id}>
                                    {(item) => (
                                        <section
                                            {...windowProps(
                                                branchTab(item().id),
                                            )}>
                                            <Show
                                                when={
                                                    matches(
                                                        branchTab(item().id),
                                                    ) && branch(item().id)
                                                }>
                                                {(current) => (
                                                    <BranchPanel
                                                        workPackage={detail()}
                                                        branch={current()}
                                                        delivery={delivery(
                                                            current(),
                                                        )}
                                                        tools={
                                                            props.snapshot.tools
                                                        }
                                                        changed={props.changed}
                                                        workPackageChanged={
                                                            changed
                                                        }
                                                        conflicted={
                                                            offerConflict
                                                        }
                                                    />
                                                )}
                                            </Show>
                                        </section>
                                    )}
                                </For>
                                <For each={detail().workRuns}>
                                    {(item) => (
                                        <section
                                            {...windowProps(runTab(item.id))}>
                                            <Show
                                                when={
                                                    matches(runTab(item.id)) &&
                                                    detail().workRuns.find(
                                                        (run) =>
                                                            run.id === item.id,
                                                    )
                                                }
                                                keyed>
                                                {(current) => (
                                                    <RunPanel
                                                        workPackage={detail()}
                                                        run={current}
                                                        openTask={
                                                            props.openTask
                                                        }
                                                        changed={changed}
                                                        editSupervisor={
                                                            editSupervisor
                                                        }
                                                        resumePipeline={
                                                            resumePipeline
                                                        }
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
