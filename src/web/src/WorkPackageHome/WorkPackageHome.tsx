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
    props.snapshot.tasks.filter((task) => task.status === "in_progress").length
  const review = () =>
    props.snapshot.tasks.filter((task) => task.status === "dev_complete").length
  const closedWorkPackages = () =>
    workPackagesByRecentWork().filter(
      (workPackage) => workPackage.taskCount > 0 && workPackage.openCount === 0,
    )
  const currentWorkPackages = () =>
    workPackagesByRecentWork().filter(
      (workPackage) => workPackage.taskCount === 0 || workPackage.openCount > 0,
    )
  // These timestamps are retained when a task subsequently moves on, which is
  // exactly the activity signal the portfolio needs: the most recently started
  // or completed work package should remain at the top.
  const workPackagesByRecentWork = () => {
    const recentWork = new Map<string, string>()
    for (const task of props.snapshot.tasks) {
      if (!task.workPackageRef) continue
      const at = [task.startedAt, task.devCompletedAt].reduce<string | null>(
        (latest, timestamp) =>
          !timestamp || (latest && latest >= timestamp) ? latest : timestamp,
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
    <main class={`${styles.scope} app-shell min-h-screen text-slate-950`}>
      <ProductRail active="work-packages" select={props.select} />
      <section class="work-surface">
        <header class="portfolio-header">
          <div class="portfolio-copy">
            <p class="eyebrow">Engineering operations</p>
            <h1>Work in motion</h1>
            <p>
              Plan grouped changes, direct agents, and keep the evidence needed
              to ship with confidence.
            </p>
          </div>
          <button class="button-primary header-action" onClick={props.create}>
            <PlusIcon />
            New work package
          </button>
          <dl class="portfolio-stats">
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
        <div class="ledger-heading">
          <div>
            <h2>Portfolio</h2>
            <p>{props.snapshot.tasks.length} tasks across the workspace</p>
          </div>
          <span>Dev complete / total</span>
        </div>
        <div class="work-package-ledger">
          <For each={currentWorkPackages()}>
            {(workPackage) => (
              <WorkPackageCard
                workPackage={workPackage}
                tasks={props.snapshot.tasks.filter(
                  (task) => task.workPackageRef === workPackage.ref,
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
                  openCount: loose().filter((task) => task.status !== "closed")
                    .length,
                } as WorkPackageSummary
              }
              tasks={loose()}
              open={() => props.open(UNASSIGNED_REF)}
              legacy
            />
          </Show>
        </div>
        <Show when={closedWorkPackages().length}>
          <details class="closed-work-packages">
            <summary>
              Closed work packages <span>{closedWorkPackages().length}</span>
            </summary>
            <div class="work-package-ledger">
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
          (props.workPackage.devCompleteCount / props.workPackage.taskCount) *
            100,
        )
      : 0
  return (
    <button
      class="work-package-card work package text-left"
      onClick={props.open}
    >
      <span
        class="work-package-stripe"
        style={{ background: props.workPackage.color }}
      />
      <div class="work-package-identity">
        <span class="work-package-ref">
          {props.legacy ? "Legacy work" : props.workPackage.ref}
        </span>
        <h3>{props.workPackage.name}</h3>
        <p>
          {props.workPackage.description ||
            "Add a description to define the outcome for this work package."}
        </p>
      </div>
      <div class="task-preview">
        <For
          each={props.tasks.slice(0, 3)}
          fallback={
            <p class="empty-copy">
              {props.workPackage.taskCount
                ? "All tasks are closed."
                : "No tasks yet. Open the work package to add the first one."}
            </p>
          }
        >
          {(task) => (
            <div class="task-preview-row">
              <span class={`status-dot ${statusClass(task.status)}`} />
              <span>{task.title}</span>
            </div>
          )}
        </For>
        <Show when={props.tasks.length > 3}>
          <p class="more-count">{props.tasks.length - 3} more tasks</p>
        </Show>
      </div>
      <div class="work-package-progress">
        <div class="progress-copy">
          <strong>{props.workPackage.devCompleteCount}</strong>
          <span> / {props.workPackage.taskCount}</span>
        </div>
        <div class="progress-track">
          <span
            style={{
              width: `${progress()}%`,
              background: props.workPackage.color,
            }}
          />
        </div>
        <small>{progress()}% dev complete</small>
      </div>
      <span class="open-cue" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="m9 5 7 7-7 7" />
        </svg>
      </span>
    </button>
  )
}
