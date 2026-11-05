/** Real Solid DOM and fresh JSON payloads; no requests to the API server. */
import { render } from "@solidjs/web"
import { For, Loading, Show, createMemo, refresh } from "solid-js"
import type {
    InvestigationDetail,
    Note,
    WorkPackageDetail,
} from "@shared/types"
import { createQuery } from "../src/hooks/createQuery"
import { NoteEditor } from "../src/NotesWorkspace/NoteEditor"
import { App } from "../src/App/App"
import { api } from "../src/api"
import "../src/styles.css"

const root = document.getElementById("root")!
const results: string[] = []
const tick = () => new Promise((resolve) => setTimeout(resolve, 100))
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
function check(value: unknown, label: string) {
    if (!value) throw new Error(label)
    results.push(`PASS: ${label}`)
}
function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
}

async function run() {
    let payload = {
        tasks: [
            { ref: "T-1", title: "One", status: "backlog" },
            { ref: "T-2", title: "Two", status: "backlog" },
        ],
        notes: [
            { path: "a.md", title: "A" },
            { path: "b.md", title: "B" },
        ],
        runs: [{ id: 1, status: "running" }],
    }
    let query!: ReturnType<typeof createQuery<typeof payload>>
    let titleReads = 0
    let mounts = 0
    const disposeRows = render(() => {
        query = createQuery(async () => clone(payload))
        const title = createMemo(() => {
            titleReads++
            return query.value.tasks[0].title
        })
        return (
            <Loading fallback={<p>Loading</p>}>
                <Show when={query.value}>
                    <output>{title()}</output>
                    <For each={query.value.tasks}>
                        {(task) => {
                            mounts++
                            return (
                                <p data-ref={task.ref}>
                                    {task.title} / {task.status}
                                </p>
                            )
                        }}
                    </For>
                    <For each={query.value.notes}>
                        {(note) => <p data-path={note.path}>{note.title}</p>}
                    </For>
                    <For each={query.value.runs}>
                        {(run) => <p data-run={run.id}>{run.status}</p>}
                    </For>
                </Show>
            </Loading>
        )
    }, root)
    await tick()
    const first = root.querySelector('[data-ref="T-1"]')
    const second = root.querySelector('[data-ref="T-2"]')
    const note = root.querySelector('[data-path="b.md"]')
    const runRow = root.querySelector('[data-run="1"]')
    const reads = titleReads
    await refresh(query)
    await tick()
    check(
        titleReads === reads && mounts === 2,
        "identical JSON refresh neither recomputes unchanged title nor remounts rows",
    )
    payload.tasks[0].status = "in_progress"
    payload.runs[0].status = "finished"
    await refresh(query)
    await tick()
    check(
        first === root.querySelector('[data-ref="T-1"]') &&
            first?.textContent?.includes("in_progress"),
        "changed task updates its existing DOM row",
    )
    check(
        second === root.querySelector('[data-ref="T-2"]') &&
            titleReads === reads,
        "unrelated task and title computation stay untouched",
    )
    check(
        runRow === root.querySelector('[data-run="1"]') &&
            runRow?.textContent === "finished",
        "id-keyed runs retain identity while updating",
    )
    payload.tasks.reverse()
    payload.notes.reverse()
    await refresh(query)
    await tick()
    check(
        second === root.querySelector("[data-ref]") &&
            note === root.querySelector("[data-path]"),
        "ref- and path-keyed records move without remounting",
    )
    payload.tasks = [
        payload.tasks[0],
        { ref: "T-3", title: "Three", status: "backlog" },
    ]
    await refresh(query)
    await tick()
    check(
        !first?.isConnected && mounts === 3 && second?.isConnected,
        "removing and inserting records only mounts the new row",
    )
    disposeRows()

    let document: Note | null = {
        path: "one.md",
        title: "First",
        tags: [],
        body: "Original",
    } as unknown as Note
    let selected!: ReturnType<typeof createQuery<Note | null>>
    const disposeEditor = render(() => {
        selected = createQuery(async () => clone(document))
        return (
            <Loading>
                <Show when={selected.value} keyed>
                    {(note) => (
                        <NoteEditor
                            note={note}
                            mode="write"
                            setMode={() => {}}
                            saved={async () => {}}
                            close={() => {}}
                            add={() => {}}
                        />
                    )}
                </Show>
            </Loading>
        )
    }, root)
    await tick()
    const editor = root.querySelector("textarea")!
    check(!!editor, "note editor mounts after initial query")
    input(editor, "Unsaved draft")
    editor.focus()
    editor.setSelectionRange(4, 8)
    await refresh(selected)
    await tick()
    check(
        root.querySelector("textarea") === editor &&
            editor.value === "Unsaved draft" &&
            editor.selectionStart === 4,
        "unchanged refresh preserves editor DOM, draft, and selection",
    )
    document = { ...document, title: "Renamed externally" }
    await refresh(selected)
    await tick()
    check(
        root.querySelector<HTMLInputElement>("input")?.value ===
            "Renamed externally" && editor.value === "Unsaved draft",
        "external title updates without overwriting the unrelated body draft",
    )
    document = {
        ...document,
        path: "two.md",
        title: "Second",
        body: "Another record",
    }
    await refresh(selected)
    await tick()
    check(
        root.querySelector("textarea") !== editor &&
            root.querySelector("textarea")?.value === "Another record",
        "navigation to a different path creates a fresh editor",
    )
    document = null
    await refresh(selected)
    await tick()
    check(
        !root.querySelector("textarea"),
        "a null result disposes the selected record",
    )
    disposeEditor()

    const originalEvents = globalThis.EventSource
    let events!: EventTarget
    class FakeEvents extends EventTarget {
        constructor(_url: string) {
            super()
            events = this
        }
        close() {}
    }
    globalThis.EventSource = FakeEvents as unknown as typeof EventSource
    const investigation = {
        ref: "INV-1",
        title: "Research",
        brief: "Question",
        status: "draft",
        createdAt: "2026-09-01",
        updatedAt: "initial",
        tasks: [],
        notes: [],
    } as unknown as InvestigationDetail
    let detail = {
        id: 1,
        ref: "WP-1",
        name: "Workspace",
        brief: "",
        color: "#3344ff",
        position: 0,
        createdAt: "2026-09-01",
        updatedAt: "initial",
        branchNames: [],
        taskCount: 0,
        devCompleteCount: 0,
        openCount: 0,
        tasks: [],
        investigations: [investigation],
        branches: [],
        queue: [],
        outsideBlockers: [],
        inProgress: [],
        baseBranch: "main",
        run: null,
        workRuns: [],
    } as WorkPackageDetail
    let workspaceReads = 0
    api.listWorkPackages = async () => {
        workspaceReads++
        return [clone(detail)]
    }
    api.listTasks = async () => []
    api.listInvestigations = async () => [clone(investigation)]
    api.listBranches = async () => ({
        branches: [],
        currentBranch: "main",
        localBranches: [],
        defaultBase: "main",
    })
    api.meta = async () =>
        ({
            aioVrInstalled: false,
            aioVrWorkspaceExists: false,
            tools: {},
        }) as Awaited<ReturnType<typeof api.meta>>
    api.getWorkPackage = async () => clone(detail)
    api.getInvestigation = async () => clone(investigation)
    api.listAgentRuns = async () => []
    history.replaceState(null, "", "/")
    const disposeApp = render(() => <App />, root)
    await tick()
    const card = [...root.querySelectorAll("button")].find((el) =>
        el.textContent?.includes("Workspace"),
    )!
    check(!!card, "app snapshot loads the work package home")
    const initialReads = workspaceReads
    events.dispatchEvent(
        new MessageEvent("change", {
            data: JSON.stringify({ channel: "notes" }),
        }),
    )
    await tick()
    check(
        workspaceReads === initialReads,
        "notes events skip task, branch, and tool discovery refreshes",
    )
    events.dispatchEvent(
        new MessageEvent("change", {
            data: JSON.stringify({ channel: "tasks" }),
        }),
    )
    await tick()
    check(
        workspaceReads === initialReads + 1,
        "task events still refresh the workspace",
    )
    events.dispatchEvent(new Event("change"))
    await tick()
    check(
        card.isConnected,
        "background app snapshot refresh preserves the home card",
    )
    card.click()
    await tick()
    const tab = [...root.querySelectorAll('[role="tab"]')].find((el) =>
        el.textContent?.includes("Research"),
    )!
    const brief = root.querySelector("textarea")!
    check(!!tab && !!brief, "work package loads its investigation panel")
    input(brief, "Unfinished investigation draft")
    detail = { ...detail, name: "Workspace renamed" }
    events.dispatchEvent(new Event("change"))
    await tick()
    check(
        tab.isConnected &&
            root.querySelector("textarea") === brief &&
            brief.value === "Unfinished investigation draft",
        "unrelated workspace refresh preserves tab, panel, and unsaved brief",
    )
    check(
        root.querySelector("h1")?.textContent === "Workspace renamed",
        "changed workspace name reaches the existing page",
    )
    investigation.title = "Research renamed"
    investigation.updatedAt = "updated"
    detail.investigations = [clone(investigation)]
    events.dispatchEvent(new Event("change"))
    await tick()
    check(
        tab.isConnected &&
            tab.textContent?.includes("Research renamed") &&
            root.querySelector("textarea") === brief,
        "tab rename updates in place and investigation detail refresh retains its panel",
    )
    detail.investigations = []
    events.dispatchEvent(new Event("change"))
    await tick()
    check(
        !tab.isConnected &&
            root
                .querySelector('[role="tab"][aria-selected="true"]')
                ?.textContent?.includes("Tasks"),
        "removing the active tab selects Tasks and disposes its panel",
    )
    disposeApp()
    globalThis.EventSource = originalEvents
}

run()
    .then(() => {
        document.getElementById("results")!.textContent =
            `${results.join("\n")}\nALL CHECKS PASSED`
    })
    .catch((error) => {
        document.getElementById("results")!.textContent =
            `${results.join("\n")}\nFAIL: ${error.stack ?? error}`
    })
