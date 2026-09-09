import {
  Errored,
  Loading,
  Show,
  createMemo,
  createSignal,
  onSettled,
  refresh,
} from "solid-js"
import { CreateGroup } from "../CreateGroup/CreateGroup"
import { GroupHome } from "../GroupHome/GroupHome"
import { GroupWorkspace } from "../GroupWorkspace/GroupWorkspace"
import { IssuesWorkspace } from "../IssuesWorkspace/IssuesWorkspace"
import { NotesWorkspace } from "../NotesWorkspace/NotesWorkspace"
import { TaskWorkspace } from "../TaskWorkspace/TaskWorkspace"
import { PageSkeleton } from "../components/PageSkeleton"
import type { MainView } from "../types/navigation"
import { loadWorkspace } from "./loadWorkspace"

export function App() {
  const snapshot = createMemo(loadWorkspace)
  const initial = /^\/groups\/([^/]+)(?:\/tasks\/([^/]+))?/.exec(
    location.pathname,
  )
  const [groupRef, setGroupRef] = createSignal<string | null>(
    initial?.[1] ? decodeURIComponent(initial[1]) : null,
  )
  const [taskRef, setTaskRef] = createSignal<string | null>(
    initial?.[2] ? decodeURIComponent(initial[2]) : null,
  )
  const [view, setView] = createSignal<MainView>(
    location.pathname === "/notes"
      ? "notes"
      : location.pathname === "/issues"
        ? "issues"
        : "groups",
  )
  const [creating, setCreating] = createSignal(false)

  // Solid 2 replaces onMount + component-level onCleanup with one lifecycle
  // callback whose return value performs teardown.
  onSettled(() => {
    const restoreLocation = () => {
      const match = /^\/groups\/([^/]+)(?:\/tasks\/([^/]+))?/.exec(
        location.pathname,
      )
      setGroupRef(match?.[1] ? decodeURIComponent(match[1]) : null)
      setTaskRef(match?.[2] ? decodeURIComponent(match[2]) : null)
      setView(
        location.pathname === "/notes"
          ? "notes"
          : location.pathname === "/issues"
            ? "issues"
            : "groups",
      )
    }
    addEventListener("popstate", restoreLocation)
    return () => removeEventListener("popstate", restoreLocation)
  })

  const openGroup = (ref: string) => {
    setView("groups")
    setGroupRef(ref)
    setTaskRef(null)
    history.pushState(null, "", `/groups/${encodeURIComponent(ref)}`)
  }
  const openTask = (ref: string) => {
    setTaskRef(ref)
    history.pushState(
      null,
      "",
      `/groups/${encodeURIComponent(groupRef()!)}/tasks/${encodeURIComponent(ref)}`,
    )
  }
  const home = () => {
    setView("groups")
    setGroupRef(null)
    setTaskRef(null)
    history.pushState(null, "", "/")
  }
  const backToGroup = () => {
    setTaskRef(null)
    history.pushState(null, "", `/groups/${encodeURIComponent(groupRef()!)}`)
  }
  const selectView = (next: MainView) => {
    setView(next)
    setGroupRef(null)
    setTaskRef(null)
    history.pushState(null, "", next === "groups" ? "/" : `/${next}`)
  }
  const reload = () => refresh(snapshot)

  return (
    <Errored
      fallback={(error, reset) => (
        <main class="grid min-h-screen place-items-center bg-slate-50 p-6">
          <div class="max-w-lg rounded-2xl bg-white p-6 ring-1 ring-red-200">
            <h1 class="text-lg font-semibold">The new UI hit a problem</h1>
            <p class="mt-2 text-sm text-red-700">{String(error())}</p>
            <button class="button-primary mt-4" onClick={reset}>
              Try again
            </button>
          </div>
        </main>
      )}
    >
      <Loading fallback={<PageSkeleton />}>
        <Show when={view() === "notes"}>
          <NotesWorkspace select={selectView} />
        </Show>
        <Show when={view() === "issues"}>
          <IssuesWorkspace select={selectView} />
        </Show>
        <Show when={view() === "groups"}>
          <Show
            when={groupRef()}
            fallback={
              <GroupHome
                snapshot={snapshot()}
                open={openGroup}
                create={() => setCreating(true)}
                select={selectView}
              />
            }
          >
            {(group) => (
              <Show
                when={taskRef()}
                fallback={
                  <GroupWorkspace
                    groupRef={group()}
                    snapshot={snapshot()}
                    back={home}
                    openTask={openTask}
                    changed={reload}
                  />
                }
              >
                {(task) => (
                  <TaskWorkspace
                    groupRef={group()}
                    taskRef={task()}
                    snapshot={snapshot()}
                    back={backToGroup}
                    openTask={openTask}
                    changed={reload}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
        <Show when={creating()}>
          <CreateGroup
            snapshot={snapshot()}
            close={() => setCreating(false)}
            created={(ref) => {
              setCreating(false)
              reload()
              openGroup(ref)
            }}
          />
        </Show>
      </Loading>
    </Errored>
  )
}
