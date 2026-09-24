import type { WorkPackageSummary } from "@shared/types"
import { For, Show, createMemo } from "solid-js"
import { ProductRail } from "../components/ProductRail"
import { PlusIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import type { WorkspaceSnapshot } from "../types/workspace"
import { UNASSIGNED_REF } from "../utils/workPackages"
import { WorkPackageCard } from "./WorkPackageCard"
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
    // or completed work package should remain at the top. Creating a work package
    // counts too, so a new one leads until another is worked on.
    const workPackagesByRecentWork = createMemo(() => {
        const recentWork = new Map<string, string>(
            props.snapshot.workPackages.map((workPackage) => [
                workPackage.ref,
                workPackage.createdAt,
            ]),
        )
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
    })
    return (
        <main
            class={`${styles.scope} app-shell min-h-screen text-slate-950 grid grid-cols-[220px_minmax(0,_1fr)] max-[820px]:block`}>
            <ProductRail active="work-packages" select={props.select} />
            <section class="work-surface min-w-0 p-[2.2rem_clamp(1.3rem,_3.5vw,_4.5rem)_4rem] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[820px]:p-[1.25rem] max-[820px]:overflow-hidden">
                <header class="portfolio grid grid-cols-[minmax(0,_1fr)_auto] gap-[2rem] max-w-[1500px] m-[0_auto_2.8rem] p-[clamp(1rem,_2vw,_2rem)_0_0] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[820px]:mb-[2rem] max-[560px]:block">
                    <hgroup class="min-w-0 max-w-[760px] p-[1.6rem_clamp(1.5rem,_3vw,_3rem)_2.2rem] max-[560px]:p-[1.35rem_1.25rem_1.75rem]">
                        <p class="eyebrow m-0">Engineering operations</p>
                        <h1 class="max-w-[720px] m-[0.45rem_0_0]">
                            Work in motion
                        </h1>
                        <p class="max-w-[590px] m-[1.25rem_0_0]">
                            Plan grouped changes, direct agents, and keep the
                            evidence needed to ship with confidence.
                        </p>
                    </hgroup>
                    <button
                        class="primary header-action self-start m-[1.7rem_clamp(1.5rem,_3vw,_3rem)_0_0] max-[560px]:m-[0_1.25rem_1.5rem]"
                        onClick={props.create}>
                        <PlusIcon />
                        New work package
                    </button>
                    <dl class="metrics col-[1_/_-1] grid grid-cols-[repeat(3,_minmax(0,_1fr))] m-0 [&>div]:flex [&>div]:min-w-0 [&>div]:min-h-[5.5rem] [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-[1rem] [&>div]:p-[1.45rem_clamp(1.5rem,_3vw,_3rem)] [&_dd]:m-0 max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full max-[560px]:[&>div]:block max-[560px]:[&>div]:min-h-[4.5rem] max-[560px]:[&>div]:p-[0.9rem_0.75rem] max-[560px]:[&>div]:overflow-hidden max-[560px]:[&_dt]:overflow-hidden max-[560px]:[&_dd]:mt-[0.2rem]">
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
                <header class="collection flex max-w-[1500px] items-end justify-between gap-[1rem] m-[0_auto_0.9rem]">
                    <div>
                        <h2 class="m-0">Portfolio</h2>
                        <p class="m-[0.2rem_0_0]">
                            {props.snapshot.tasks.length} tasks across the
                            workspace
                        </p>
                    </div>
                    <span class="m-[0.2rem_0_0] max-[560px]:hidden">
                        Dev complete / total
                    </span>
                </header>
                <section class="collection max-w-[1500px] m-[0_auto] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full">
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
                                    brief: "Legacy tasks created before work package membership became mandatory.",
                                    branchNames: [] as string[],
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
                </section>
                <Show when={closedWorkPackages().length}>
                    <section class="collection max-w-[1500px] m-[1.5rem_auto_0]">
                        <summary class="flex items-center justify-between p-[0.85rem_1rem] [&::-webkit-details-marker]:hidden before:mr-[0.6rem]">
                            Closed work packages{" "}
                            <span class="ml-auto">
                                {closedWorkPackages().length}
                            </span>
                        </summary>
                        <section class="collection max-w-[1500px] m-[0_auto] mt-[0.5rem] max-[820px]:w-full max-[820px]:min-w-0 max-[820px]:max-w-full">
                            <For each={closedWorkPackages()}>
                                {(workPackage) => (
                                    <WorkPackageCard
                                        workPackage={workPackage}
                                        tasks={[]}
                                        open={() => props.open(workPackage.ref)}
                                    />
                                )}
                            </For>
                        </section>
                    </section>
                </Show>
            </section>
        </main>
    )
}
