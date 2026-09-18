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
import { BackIcon, PlusIcon } from "../components/icons"
import type { WorkspaceSnapshot } from "../types/workspace"
import { UNASSIGNED_REF } from "../utils/workPackages"
import { BranchPanel } from "./BranchPanel"
import { InvestigationPanel } from "./InvestigationPanel"
import { LegacyWorkPackage } from "./LegacyWorkPackage"
import { WorkPackageOverview } from "./WorkPackageOverview"
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
    const { capture, clear, Banner } = useError()
    const [busy, setBusy] = createOptimistic("")
    const {
        setActiveTab: setTab,
        matches,
        tabProps,
        windowProps,
    } = useTabs<"overview" | "investigation" | "branch">(() =>
        workPackage()?.tasks.length ? "overview" : "investigation",
    )
    const changed = () => {
        refresh(workPackage)
        props.changed()
    }
    const { openDialog: openAgent } = useDialog(({ closeDialog }) => (
        <Show when={workPackage()} keyed>
            {(detail) => (
                <AgentLauncher
                    workPackage={detail}
                    close={closeDialog}
                    finished={changed}
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
        <Show when={workPackage()?.investigations[0]} keyed>
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
                    const investigation = () => detail.investigations[0]
                    const branch = () => detail.branches[0]
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
                                                <p class="description max-w-[70ch] m-[0.8rem_0_0]">
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
                                                    <button
                                                        class="primary"
                                                        onClick={() =>
                                                            investigation()
                                                                ? openInvestigation()
                                                                : setTab(
                                                                      "investigation",
                                                                  )
                                                        }>
                                                        {investigation()
                                                            ?.status ===
                                                        "complete"
                                                            ? "Run investigation again"
                                                            : "Run investigation"}
                                                    </button>
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
                                    <nav
                                        role="tablist"
                                        aria-label="Work package"
                                        class="underlined flex gap-[1.5rem] mt-[2rem] max-[560px]:gap-[1rem]">
                                        <button ref={tabProps("overview")}>
                                            Tasks
                                        </button>
                                        <button ref={tabProps("investigation")}>
                                            Investigation
                                        </button>
                                        <button ref={tabProps("branch")}>
                                            Branch
                                        </button>
                                    </nav>
                                </div>
                            </header>
                            <div class="mx-auto max-w-[1600px] px-5 py-8 sm:px-8">
                                <Banner />
                                <section {...windowProps("overview")}>
                                    <Show when={matches("overview")}>
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
                                </section>
                                <section {...windowProps("investigation")}>
                                    <Show when={matches("investigation")}>
                                        <InvestigationPanel
                                            investigation={investigation()}
                                            workPackage={detail}
                                            changed={() => {
                                                props.changed()
                                                refresh(workPackage)
                                            }}
                                        />
                                    </Show>
                                </section>
                                <section {...windowProps("branch")}>
                                    <Show
                                        when={matches("branch") && branch()}
                                        keyed>
                                        {(branch) => (
                                            <BranchPanel
                                                workPackage={detail}
                                                branch={branch}
                                                delivery={delivery(branch)}
                                                tools={props.snapshot.tools}
                                                changed={props.changed}
                                                workPackageChanged={() => {
                                                    refresh(workPackage)
                                                    props.changed()
                                                }}
                                            />
                                        )}
                                    </Show>
                                </section>
                            </div>
                        </>
                    )
                }}
            </Show>
        )
    }
}
