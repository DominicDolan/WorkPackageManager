import { For, Show } from "solid-js"
import type { Task, WorkPackageSummary } from "@shared/types"
import { ProductRail } from "../components/ProductRail"
import { PlusIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import type { WorkspaceSnapshot } from "../types/workspace"
import { UNASSIGNED_REF } from "../utils/workPackages"
import { statusClass } from "../utils/statusClass"
import styles from "./WorkPackageHome.module.css"

export function WorkPackageHome(props: {
    snapshot: WorkspaceSnapshot
    open: (ref: string) => void
    create: () => void
    select: (view: MainView) => void
}) {
    const loose = () =>
        props.snapshot.tasks.filter((task) => !task.workPackageRef)
    const active = () =>
        props.snapshot.tasks.filter((task) => task.status === "in_progress")
            .length
    const review = () =>
        props.snapshot.tasks.filter((task) => task.status === "dev_complete")
            .length
    const closedWorkPackages = () =>
        workPackagesByRecentWork().filter(
            (workPackage) =>
                workPackage.taskCount > 0 && workPackage.openCount === 0,
        )
    const currentWorkPackages = () =>
        workPackagesByRecentWork().filter(
            (workPackage) =>
                workPackage.taskCount === 0 || workPackage.openCount > 0,
        )
    // These timestamps are retained when a task subsequently moves on, which is
    // exactly the activity signal the portfolio needs: the most recently started
    // or completed work package should remain at the top.
    const workPackagesByRecentWork = () => {
        const recentWork = new Map<string, string>()
        for (const task of props.snapshot.tasks) {
            if (!task.workPackageRef) continue
            const at = [task.startedAt, task.devCompletedAt].reduce<
                string | null
            >(
                (latest, timestamp) =>
                    !timestamp || (latest && latest >= timestamp)
                        ? latest
                        : timestamp,
                null,
            )
            if (
                at &&
                (!recentWork.has(task.workPackageRef) ||
                    recentWork.get(task.workPackageRef)! < at)
            ) {
                recentWork.set(task.workPackageRef, at)
            }
        }

        return [...props.snapshot.workPackages].sort((left, right) => {
            const leftAt = recentWork.get(left.ref)
            const rightAt = recentWork.get(right.ref)
            if (leftAt && rightAt) return rightAt.localeCompare(leftAt)
            if (leftAt) return -1
            if (rightAt) return 1
            return 0
        })
    }
    return (
        <main
            class={`${styles.scope} app-shell min-h-screen text-slate-950 grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block`}
        >
            <ProductRail active="work-packages" select={props.select} />
            <section class="work-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                <header class="portfolio-header grid grid-cols-[minmax(0,_1fr)_auto] gap-[2rem] max-w-[1500px] m-[0_auto_2.8rem] p-[clamp(1rem,_2vw,_2rem)_0_0] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[820px]:mb-[2rem] max-[560px]:block">
                    <div class="portfolio-copy min-w-0 max-w-[760px] p-[1.6rem_clamp(1.5rem,_3vw,_3rem)_2.2rem] [&_h1]:max-w-[720px] [&_h1]:m-[0.45rem_0_0] [&>p:last-child]:max-w-[590px] [&>p:last-child]:m-[1.25rem_0_0] max-[560px]:p-[1.35rem_1.25rem_1.75rem]">
                        <p class="eyebrow m-0">Engineering operations</p>
                        <h1>Work in motion</h1>
                        <p>
                            Plan grouped changes, direct agents, and keep the
                            evidence needed to ship with confidence.
                        </p>
                    </div>
                    <button
                        class="button-primary header-action inline-flex min-h-[2.5rem] items-center justify-center gap-[0.45rem] p-[0.5rem_0.9rem] self-start m-[1.7rem_clamp(1.5rem,_3vw,_3rem)_0_0] max-[560px]:m-[0_1.25rem_1.5rem]"
                        onClick={props.create}
                    >
                        <PlusIcon />
                        New work package
                    </button>
                    <dl class="portfolio-stats col-[1_/_-1] grid grid-cols-[repeat(3,_minmax(0,_1fr))] m-0 [&>div]:flex [&>div]:min-w-0 [&>div]:min-h-[5.5rem] [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-[1rem] [&>div]:p-[1.45rem_clamp(1.5rem,_3vw,_3rem)] [&_dd]:m-0 max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[560px]:[&>div]:block max-[560px]:[&>div]:min-h-[4.5rem] max-[560px]:[&>div]:p-[0.9rem_0.75rem] max-[560px]:[&>div]:overflow-hidden max-[560px]:[&_dt]:overflow-hidden max-[560px]:[&_dd]:mt-[0.2rem]">
                        <div>
                            <dt>Work packages</dt>
                            <dd>{props.snapshot.workPackages.length}</dd>
                        </div>
                        <div>
                            <dt>In progress</dt>
                            <dd>{active()}</dd>
                        </div>
                        <div>
                            <dt>Ready to review</dt>
                            <dd>{review()}</dd>
                        </div>
                    </dl>
                </header>
                <div class="ledger-heading flex max-w-[1500px] items-end justify-between gap-[1rem] m-[0_auto_0.9rem] [&_h2]:m-0 [&_p]:m-[0.2rem_0_0] [&>span]:m-[0.2rem_0_0] max-[560px]:[&>span]:hidden">
                    <div>
                        <h2>Portfolio</h2>
                        <p>
                            {props.snapshot.tasks.length} tasks across the
                            workspace
                        </p>
                    </div>
                    <span>Dev complete / total</span>
                </div>
                <div class="work-package-ledger max-w-[1500px] m-[0_auto] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full">
                    <For each={currentWorkPackages()}>
                        {(workPackage) => (
                            <WorkPackageCard
                                workPackage={workPackage}
                                tasks={props.snapshot.tasks.filter(
                                    (task) =>
                                        task.workPackageRef === workPackage.ref,
                                )}
                                open={() => props.open(workPackage.ref)}
                            />
                        )}
                    </For>
                    <Show when={loose().length}>
                        <WorkPackageCard
                            workPackage={
                                {
                                    ref: UNASSIGNED_REF,
                                    name: "Unassigned",
                                    description:
                                        "Legacy tasks created before work package membership became mandatory.",
                                    color: "#94a3b8",
                                    taskCount: loose().length,
                                    devCompleteCount: loose().filter(
                                        (task) =>
                                            task.status === "dev_complete" ||
                                            task.status === "verified" ||
                                            task.status === "closed",
                                    ).length,
                                    openCount: loose().filter(
                                        (task) => task.status !== "closed",
                                    ).length,
                                } as WorkPackageSummary
                            }
                            tasks={loose()}
                            open={() => props.open(UNASSIGNED_REF)}
                            legacy
                        />
                    </Show>
                </div>
                <Show when={closedWorkPackages().length}>
                    <details class="closed-work-packages max-w-[1500px] m-[1.5rem_auto_0] [&>summary]:flex [&>summary]:items-center [&>summary]:justify-between [&>summary]:p-[0.85rem_1rem] [&>summary::-webkit-details-marker]:hidden [&>summary::before]:mr-[0.6rem] [&>summary_span]:ml-auto [&>.work-package-ledger]:mt-[0.5rem]">
                        <summary>
                            Closed work packages{" "}
                            <span>{closedWorkPackages().length}</span>
                        </summary>
                        <div class="work-package-ledger max-w-[1500px] m-[0_auto] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full">
                            <For each={closedWorkPackages()}>
                                {(workPackage) => (
                                    <WorkPackageCard
                                        workPackage={workPackage}
                                        tasks={[]}
                                        open={() => props.open(workPackage.ref)}
                                    />
                                )}
                            </For>
                        </div>
                    </details>
                </Show>
            </section>
        </main>
    )
}

function WorkPackageCard(props: {
    workPackage: WorkPackageSummary
    tasks: Task[]
    open: () => void
    legacy?: boolean
}) {
    const progress = () =>
        props.workPackage.taskCount
            ? Math.round(
                  (props.workPackage.devCompleteCount /
                      props.workPackage.taskCount) *
                      100,
              )
            : 0
    return (
        <button
            class="work-package-card work package text-left relative grid w-full grid-cols-[6px_minmax(240px,_1.2fr)_minmax(220px,_1fr)_150px_38px] items-center gap-[clamp(1rem,_2vw,_2.5rem)] overflow-hidden focus-visible:z-[1] max-[1050px]:grid-cols-[6px_minmax(230px,_1.25fr)_minmax(180px,_1fr)_120px_30px] max-[1050px]:gap-[1.2rem] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[820px]:grid-cols-[6px_minmax(0,_1fr)_100px_28px] max-[560px]:grid-cols-[5px_minmax(0,_1fr)] max-[560px]:gap-[1rem]"
            onClick={props.open}
        >
            <span
                class="work-package-stripe self-stretch"
                style={{ background: props.workPackage.color }}
            />
            <div class="work-package-identity min-w-0 p-[1.55rem_0] [&_h3]:m-[0.35rem_0_0] [&_p]:line-clamp-2 [&_p]:max-w-[52ch] [&_p]:m-[0.45rem_0_0] [&_p]:overflow-hidden max-[820px]:overflow-hidden max-[560px]:p-[1.2rem_0]">
                <span class="work-package-ref">
                    {props.legacy ? "Legacy work" : props.workPackage.ref}
                </span>
                <h3>{props.workPackage.name}</h3>
                <p>
                    {props.workPackage.description ||
                        "Add a description to define the outcome for this work package."}
                </p>
            </div>
            <div class="task-preview min-w-0 p-[1.25rem_0] max-[820px]:hidden">
                <For
                    each={props.tasks.slice(0, 3)}
                    fallback={
                        <p class="empty-copy m-[0.5rem_0_0] m-[0.5rem_0_0_1.05rem] ml-0">
                            {props.workPackage.taskCount
                                ? "All tasks are closed."
                                : "No tasks yet. Open the work package to add the first one."}
                        </p>
                    }
                >
                    {(task) => (
                        <div class="task-preview-row flex min-w-0 items-center gap-[0.6rem] m-[0.45rem_0] [&>span:last-child]:overflow-hidden">
                            <span
                                class={`status-dot ${statusClass(task.status)} w-[0.45rem] h-[0.45rem] flex-none`}
                            />
                            <span>{task.title}</span>
                        </div>
                    )}
                </For>
                <Show when={props.tasks.length > 3}>
                    <p class="more-count m-[0.5rem_0_0_1.05rem]">
                        {props.tasks.length - 3} more tasks
                    </p>
                </Show>
            </div>
            <div class="work-package-progress p-[1.25rem_0] [&_small]:block [&_small]:mt-[0.38rem] max-[560px]:hidden">
                <div class="progress-copy">
                    <strong>{props.workPackage.devCompleteCount}</strong>
                    <span> / {props.workPackage.taskCount}</span>
                </div>
                <div class="progress-track h-[3px] mt-[0.65rem] overflow-hidden [&_span]:block [&_span]:h-full">
                    <span
                        style={{
                            width: `${progress()}%`,
                            background: props.workPackage.color,
                        }}
                    />
                </div>
                <small>{progress()}% dev complete</small>
            </div>
            <span
                class="open-cue grid w-[2rem] h-[2rem] place-items-center [&_svg]:w-[1.15rem] max-[560px]:hidden"
                aria-hidden="true"
            >
                <svg viewBox="0 0 24 24">
                    <path d="m9 5 7 7-7 7" />
                </svg>
            </span>
        </button>
    )
}
