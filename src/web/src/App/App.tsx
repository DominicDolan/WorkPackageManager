import { createQuery } from "../hooks/createQuery"
import {
    Errored,
    Loading,
    Show,
    createSignal,
    onSettled,
    refresh,
} from "solid-js"
import { CreateWorkPackage } from "../CreateWorkPackage/CreateWorkPackage"
import { WorkPackageHome } from "../WorkPackageHome/WorkPackageHome"
import { WorkPackageWorkspace } from "../WorkPackageWorkspace/WorkPackageWorkspace"
import { NotesWorkspace } from "../NotesWorkspace/NotesWorkspace"
import { TranscriptsWorkspace } from "../TranscriptsWorkspace/TranscriptsWorkspace"
import { TaskWorkspace } from "../TaskWorkspace/TaskWorkspace"
import { PageSkeleton } from "../components/PageSkeleton"
import type { MainView } from "../types/navigation"
import { loadWorkspace } from "./loadWorkspace"

/** Issues share the Notes page now; `/issues` links from before still land there. */
function viewAt(pathname: string): MainView {
    if (pathname === "/transcripts") return "transcripts"
    return pathname === "/notes" || pathname === "/issues"
        ? "notes"
        : "work-packages"
}

export function App() {
    const snapshot = createQuery(loadWorkspace)
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
    const [view, setView] = createSignal<MainView>(viewAt(location.pathname))
    const [notePath, setNotePath] = createSignal(
        new URLSearchParams(location.search).get("note") ?? "",
    )
    const [issueId, setIssueId] = createSignal(
        new URLSearchParams(location.search).get("issue") ?? "",
    )
    const [transcriptPath, setTranscriptPath] = createSignal(
        new URLSearchParams(location.search).get("transcript") ?? "",
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
            setIssueId(new URLSearchParams(location.search).get("issue") ?? "")
            setTranscriptPath(
                new URLSearchParams(location.search).get("transcript") ?? "",
            )
            setView(viewAt(location.pathname))
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
        setIssueId("")
        setTranscriptPath("")
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
            )}>
            <Loading fallback={<PageSkeleton />}>
                <Show when={view() === "notes"}>
                    <NotesWorkspace
                        select={selectView}
                        openWorkPackage={openWorkPackage}
                        initialPath={notePath()}
                        initialIssueId={issueId()}
                        revision={workspaceRevision()}
                    />
                </Show>
                <Show when={view() === "transcripts" && snapshot.value}>
                    <TranscriptsWorkspace
                        select={selectView}
                        snapshot={snapshot.value!}
                        initialPath={transcriptPath()}
                        revision={workspaceRevision()}
                    />
                </Show>
                <Show when={view() === "work-packages"}>
                    <Show when={snapshot.value}>
                        <Show
                            when={workPackageRef()}
                            fallback={
                                <WorkPackageHome
                                    snapshot={snapshot.value}
                                    open={openWorkPackage}
                                    create={() => setCreating(true)}
                                    select={selectView}
                                />
                            }>
                            {(workPackage) => (
                                <Show
                                    when={taskRef()}
                                    fallback={
                                        <WorkPackageWorkspace
                                            workPackageRef={workPackage()}
                                            snapshot={snapshot.value}
                                            back={home}
                                            openTask={openTask}
                                            changed={reload}
                                            revision={workspaceRevision()}
                                        />
                                    }>
                                    {(task) => (
                                        <TaskWorkspace
                                            workPackageRef={workPackage()}
                                            taskRef={task()}
                                            snapshot={snapshot.value}
                                            back={backToWorkPackage}
                                            openTask={openTask}
                                            changed={reload}
                                            revision={workspaceRevision()}
                                        />
                                    )}
                                </Show>
                            )}
                        </Show>
                    </Show>
                </Show>
                <Show when={creating()}>
                    <CreateWorkPackage
                        snapshot={snapshot.value}
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
