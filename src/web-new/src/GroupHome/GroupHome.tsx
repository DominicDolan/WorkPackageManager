import { For, Show } from "solid-js"
import type { Task, TaskGroupSummary } from "@shared/types"
import { ProductRail } from "../components/ProductRail"
import { PlusIcon } from "../components/icons"
import type { MainView } from "../types/navigation"
import type { WorkspaceSnapshot } from "../types/workspace"
import { UNGROUPED_REF } from "../utils/groups"
import { statusClass } from "../utils/statusClass"
import styles from "./GroupHome.module.css"

export function GroupHome(props: {
  snapshot: WorkspaceSnapshot
  open: (ref: string) => void
  create: () => void
  select: (view: MainView) => void
}) {
  const loose = () => props.snapshot.tasks.filter((task) => !task.groupRef)
  const active = () =>
    props.snapshot.tasks.filter((task) => task.status === "in_progress").length
  const review = () =>
    props.snapshot.tasks.filter((task) => task.status === "dev_complete").length
  const closedGroups = () =>
    groupsByRecentWork().filter(
      (group) => group.taskCount > 0 && group.openCount === 0,
    )
  const currentGroups = () =>
    groupsByRecentWork().filter(
      (group) => group.taskCount === 0 || group.openCount > 0,
    )
  // These timestamps are retained when a task subsequently moves on, which is
  // exactly the activity signal the portfolio needs: the most recently started
  // or completed group should remain at the top.
  const groupsByRecentWork = () => {
    const recentWork = new Map<string, string>()
    for (const task of props.snapshot.tasks) {
      if (!task.groupRef) continue
      const at = [task.startedAt, task.devCompletedAt].reduce<string | null>(
        (latest, timestamp) =>
          !timestamp || (latest && latest >= timestamp) ? latest : timestamp,
        null,
      )
      if (
        at &&
        (!recentWork.has(task.groupRef) || recentWork.get(task.groupRef)! < at)
      ) {
        recentWork.set(task.groupRef, at)
      }
    }

    return [...props.snapshot.groups].sort((left, right) => {
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
      <ProductRail active="groups" select={props.select} />
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
            New group
          </button>
          <dl class="portfolio-stats">
            <div>
              <dt>Groups</dt>
              <dd>{props.snapshot.groups.length}</dd>
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
        <div class="group-ledger">
          <For each={currentGroups()}>
            {(group) => (
              <GroupCard
                group={group}
                tasks={props.snapshot.tasks.filter(
                  (task) => task.groupRef === group.ref,
                )}
                open={() => props.open(group.ref)}
              />
            )}
          </For>
          <Show when={loose().length}>
            <GroupCard
              group={
                {
                  ref: UNGROUPED_REF,
                  name: "Ungrouped",
                  description:
                    "Legacy tasks created before group membership became mandatory.",
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
                } as TaskGroupSummary
              }
              tasks={loose()}
              open={() => props.open(UNGROUPED_REF)}
              legacy
            />
          </Show>
        </div>
        <Show when={closedGroups().length}>
          <details class="closed-groups">
            <summary>
              Closed groups <span>{closedGroups().length}</span>
            </summary>
            <div class="group-ledger">
              <For each={closedGroups()}>
                {(group) => (
                  <GroupCard
                    group={group}
                    tasks={[]}
                    open={() => props.open(group.ref)}
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

function GroupCard(props: {
  group: TaskGroupSummary
  tasks: Task[]
  open: () => void
  legacy?: boolean
}) {
  const progress = () =>
    props.group.taskCount
      ? Math.round((props.group.devCompleteCount / props.group.taskCount) * 100)
      : 0
  return (
    <button class="group-card group text-left" onClick={props.open}>
      <span class="group-stripe" style={{ background: props.group.color }} />
      <div class="group-identity">
        <span class="group-ref">
          {props.legacy ? "Legacy work" : props.group.ref}
        </span>
        <h3>{props.group.name}</h3>
        <p>
          {props.group.description ||
            "Add a description to define the outcome for this group."}
        </p>
      </div>
      <div class="task-preview">
        <For
          each={props.tasks.slice(0, 3)}
          fallback={
            <p class="empty-copy">
              {props.group.taskCount
                ? "All tasks are closed."
                : "No tasks yet. Open the group to add the first one."}
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
      <div class="group-progress">
        <div class="progress-copy">
          <strong>{props.group.devCompleteCount}</strong>
          <span> / {props.group.taskCount}</span>
        </div>
        <div class="progress-track">
          <span
            style={{ width: `${progress()}%`, background: props.group.color }}
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
