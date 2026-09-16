import {
    Errored,
    Loading,
    Show,
    createMemo,
    createSignal,
    onSettled,
    refresh,
} from "solid-js"
import { CreateWorkPackage } from "../CreateWorkPackage/CreateWorkPackage"
import { WorkPackageHome } from "../WorkPackageHome/WorkPackageHome"
import { WorkPackageWorkspace } from "../WorkPackageWorkspace/WorkPackageWorkspace"
import { IssuesWorkspace } from "../IssuesWorkspace/IssuesWorkspace"
import { NotesWorkspace } from "../NotesWorkspace/NotesWorkspace"
import { TaskWorkspace } from "../TaskWorkspace/TaskWorkspace"
import { PageSkeleton } from "../components/PageSkeleton"
import type { MainView } from "../types/navigation"
import { loadWorkspace } from "./loadWorkspace"

export function App() {
    const snapshot = createMemo(loadWorkspace)
    const initial =
        /^\/(?:work-packages|groups)\/([^/]+)(?:\/tasks\/([^/]+))?/.exec(
            location.pathname,
        )
    const [workPackageRef, setWorkPackageRef] = createSignal<string | null>(
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
              : "work-packages",
    )
    const [notePath, setNotePath] = createSignal(
        new URLSearchParams(location.search).get("note") ?? "",
    )
    const [creating, setCreating] = createSignal(false)
    const [workspaceRevision, setWorkspaceRevision] = createSignal(0)

    // Solid 2 replaces onMount + component-level onCleanup with one lifecycle
    // callback whose return value performs teardown.
    onSettled(() => {
        const restoreLocation = () => {
            const match =
                /^\/(?:work-packages|groups)\/([^/]+)(?:\/tasks\/([^/]+))?/.exec(
                    location.pathname,
                )
            setWorkPackageRef(match?.[1] ? decodeURIComponent(match[1]) : null)
            setTaskRef(match?.[2] ? decodeURIComponent(match[2]) : null)
            setNotePath(new URLSearchParams(location.search).get("note") ?? "")
            setView(
                location.pathname === "/notes"
                    ? "notes"
                    : location.pathname === "/issues"
                      ? "issues"
                      : "work-packages",
            )
        }
        addEventListener("popstate", restoreLocation)
        // The CLI and agents write through the same API server. Keep this view in
        // sync with those writes instead of leaving a stale snapshot until reload.
        const events = new EventSource("/api/events")
        const changed = () => {
            refresh(snapshot)
            setWorkspaceRevision((revision) => revision + 1)
        }
        events.addEventListener("change", changed)
        return () => {
            removeEventListener("popstate", restoreLocation)
            events.close()
        }
    })

    const openWorkPackage = (ref: string) => {
        setView("work-packages")
        setWorkPackageRef(ref)
        setTaskRef(null)
        history.pushState(null, "", `/work-packages/${encodeURIComponent(ref)}`)
    }
    const openTask = (ref: string) => {
        setTaskRef(ref)
        history.pushState(
            null,
            "",
            `/work-packages/${encodeURIComponent(workPackageRef()!)}/tasks/${encodeURIComponent(ref)}`,
        )
    }
    const openNote = (path: string) => {
        setView("notes")
        setWorkPackageRef(null)
        setTaskRef(null)
        setNotePath(path)
        history.pushState(null, "", `/notes?note=${encodeURIComponent(path)}`)
    }
    const home = () => {
        setView("work-packages")
        setWorkPackageRef(null)
        setTaskRef(null)
        history.pushState(null, "", "/")
    }
    const backToWorkPackage = () => {
        setTaskRef(null)
        history.pushState(
            null,
            "",
            `/work-packages/${encodeURIComponent(workPackageRef()!)}`,
        )
    }
    const selectView = (next: MainView) => {
        setView(next)
        setWorkPackageRef(null)
        setTaskRef(null)
        setNotePath("")
        history.pushState(null, "", next === "work-packages" ? "/" : `/${next}`)
    }
    const reload = () => refresh(snapshot)

    return (
        <Errored
            fallback={(error, reset) => (
                <main class="grid min-h-screen place-items-center bg-slate-50 p-6">
                    <article class="max-w-lg p-6 ring-1 ring-red-200">
                        <h1 class="text-lg font-semibold">
                            The app hit a problem
                        </h1>
                        <p class="mt-2 text-sm text-red-700">
                            {String(error())}
                        </p>
                        <button class="primary mt-4" onClick={reset}>
                            Try again
                        </button>
                    </article>
                </main>
            )}
        >
            <Loading fallback={<PageSkeleton />}>
                <Show when={view() === "notes"}>
                    <NotesWorkspace
                        select={selectView}
                        initialPath={notePath()}
                        revision={workspaceRevision()}
                    />
                </Show>
                <Show when={view() === "issues"}>
                    <IssuesWorkspace
                        select={selectView}
                        revision={workspaceRevision()}
                    />
                </Show>
                <Show when={view() === "work-packages"}>
                    <Show
                        when={workPackageRef()}
                        fallback={
                            <WorkPackageHome
                                snapshot={snapshot()}
                                open={openWorkPackage}
                                create={() => setCreating(true)}
                                select={selectView}
                            />
                        }
                    >
                        {(workPackage) => (
                            <Show
                                when={taskRef()}
                                fallback={
                                    <WorkPackageWorkspace
                                        workPackageRef={workPackage()}
                                        snapshot={snapshot()}
                                        back={home}
                                        openTask={openTask}
                                        openNote={openNote}
                                        changed={reload}
                                        revision={workspaceRevision()}
                                    />
                                }
                            >
                                {(task) => (
                                    <TaskWorkspace
                                        workPackageRef={workPackage()}
                                        taskRef={task()}
                                        snapshot={snapshot()}
                                        back={backToWorkPackage}
                                        openTask={openTask}
                                        openNote={openNote}
                                        changed={reload}
                                        revision={workspaceRevision()}
                                    />
                                )}
                            </Show>
                        )}
                    </Show>
                </Show>
                <Show when={creating()}>
                    <CreateWorkPackage
                        snapshot={snapshot()}
                        close={() => setCreating(false)}
                        created={(ref) => {
                            setCreating(false)
                            reload()
                            openWorkPackage(ref)
                        }}
                    />
                </Show>
            </Loading>
        </Errored>
    )
}
