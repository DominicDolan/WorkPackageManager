/** Real mutation components with deferred in-memory API requests; no server writes. */
import { render } from "@solidjs/web"
import { Show, createSignal } from "solid-js"
import type { InvestigationDetail, Note } from "@work-task-manager/shared"
import { api } from "../src/api"
import { InvestigationBrief } from "../src/WorkPackageWorkspace/InvestigationBrief"
import { NoteEditor } from "../src/NotesWorkspace/NoteEditor"
import { CreateTask } from "../src/CreateTask/CreateTask"
import { NotesWorkspace } from "../src/NotesWorkspace/NotesWorkspace"
import "../src/styles.css"

for (const key of Object.keys(api))
    Object.assign(api, {
        [key]: async () => {
            throw new Error(`Unexpected API call: ${key}`)
        },
    })
const results: string[] = []
const root = document.getElementById("root")!
const tick = () => new Promise((resolve) => setTimeout(resolve, 50))
function check(value: unknown, label: string) {
    if (!value) throw new Error(label)
    results.push(`PASS: ${label}`)
}
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
function button(label: string) {
    const found = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((el) => el.textContent?.trim() === label)
    if (!found) throw new Error(`Missing button: ${label}`)
    return found
}
function input(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
}
async function run() {
    let calls = 0
    let saved = 0
    let briefRequest = deferred<InvestigationDetail>()
    const investigation = {
        ref: "INV-1",
        brief: "Original",
    } as InvestigationDetail
    api.updateInvestigation = () => {
        calls++
        return briefRequest.promise
    }
    let dispose = render(
        () => (
            <InvestigationBrief
                investigation={investigation}
                saved={() => saved++}
            />
        ),
        root,
    )
    await tick()
    input(root.querySelector("textarea")!, "Updated")
    await tick()
    button("Save brief").click()
    await tick()
    check(
        button("Save brief").disabled &&
            button("Save brief").getAttribute("aria-busy") === "true",
        "optimistic busy state appears while request is unresolved",
    )
    button("Save brief").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
    )
    await tick()
    check(calls === 1, "duplicate submissions are ignored")
    briefRequest.reject(new Error("Save rejected"))
    await tick()
    check(
        button("Save brief").getAttribute("aria-busy") === "false" &&
            !button("Save brief").disabled,
        "failure automatically resets optimistic busy state",
    )
    check(
        root.textContent?.includes("Save rejected") &&
            saved === 0 &&
            root.querySelector("textarea")!.value === "Updated",
        "failure preserves input and skips success callback",
    )
    briefRequest = deferred()
    button("Save brief").click()
    await tick()
    briefRequest.resolve({ ...investigation, brief: "Updated" })
    await tick()
    check(
        saved === 1 &&
            !root.textContent?.includes("Save rejected") &&
            button("Save brief").getAttribute("aria-busy") === "false",
        "retry commits success and clears the error",
    )
    dispose()

    const note = {
        path: "test.md",
        title: "Note",
        body: "Original",
        tags: [],
    } as unknown as Note
    const noteRequest = deferred<Note>()
    const refreshed = deferred<void>()
    let refreshing = false
    api.updateNote = () => noteRequest.promise
    dispose = render(
        () => (
            <NoteEditor
                note={note}
                mode="write"
                setMode={() => {}}
                close={() => {}}
                add={() => {}}
                saved={() => {
                    refreshing = true
                    return refreshed.promise
                }}
            />
        ),
        root,
    )
    await tick()
    button("Save changes").click()
    await tick()
    noteRequest.resolve({ ...note, title: "Confirmed title" })
    await tick()
    check(
        refreshing &&
            button("Save changes").getAttribute("aria-busy") === "true",
        "busy state lasts through post-mutation refresh",
    )
    refreshed.resolve()
    await tick()
    check(
        button("Save changes").getAttribute("aria-busy") === "false" &&
            root.querySelector<HTMLInputElement>("input")!.value ===
                "Confirmed title",
        "typed mutation response commits after refresh",
    )
    dispose()

    const created = deferred<Awaited<ReturnType<typeof api.createTask>>>()
    api.createTask = () => created.promise
    let createdRef = ""
    dispose = render(() => {
        const [open, setOpen] = createSignal(true)
        return (
            <Show when={open()}>
                <CreateTask
                    workPackage={{ ref: "WP-1", name: "Test" }}
                    close={() => setOpen(false)}
                    created={(ref) => {
                        createdRef = ref
                        setOpen(false)
                    }}
                />
            </Show>
        )
    }, root)
    await tick()
    input(
        document.querySelector<HTMLInputElement>("dialog input[autofocus]")!,
        "New task",
    )
    await tick()
    button("Add task").click()
    await tick()
    check(
        button("Add task").getAttribute("aria-busy") === "true",
        "creation dialog stays busy during its action",
    )
    created.resolve({ ref: "T-2" } as Awaited<
        ReturnType<typeof api.createTask>
    >)
    await tick()
    check(
        createdRef === "T-2" && !document.querySelector("dialog"),
        "successful creation can close and dispose its dialog",
    )
    dispose()

    const listing = {
        issues: [],
        facets: { sources: [], labels: [], total: 0 },
        notes: {
            dir: "/fixture",
            exists: true,
            autoCommit: false,
            git: {
                repo: true,
                upstream: "origin/main",
                branch: "main",
                dirty: 0,
                lastCommit: null,
                unpushed: 0,
            },
        },
    }
    // Sync and Push follow the notes folder's Git state, read with the notes.
    const notes = {
        notes: [],
        folders: [],
        tags: [],
        workspace: listing.notes,
    }
    let reads = 0
    const readRequest = deferred<typeof notes>()
    const syncRequest = deferred<Awaited<ReturnType<typeof api.pullNotes>>>()
    api.listIssues = async () => listing
    api.listNotes = async () => (++reads === 1 ? notes : readRequest.promise)
    api.pullNotes = () => syncRequest.promise
    dispose = render(
        () => (
            <NotesWorkspace
                select={() => {}}
                openWorkPackage={() => {}}
                revision={0}
            />
        ),
        root,
    )
    await tick()
    // The initial revision effect may refresh the initial listing as well.
    readRequest.resolve(notes)
    await tick()
    const refreshRequest = deferred<typeof notes>()
    api.listNotes = () => refreshRequest.promise
    button("Sync").click()
    await tick()
    check(
        button("Sync").getAttribute("aria-busy") === "true" &&
            button("Push").getAttribute("aria-busy") === "false",
        "only the active library action shows busy state",
    )
    syncRequest.resolve({} as Awaited<ReturnType<typeof api.pullNotes>>)
    await tick()
    check(
        button("Sync").getAttribute("aria-busy") === "true",
        "real derived refresh holds the action open",
    )
    refreshRequest.resolve(notes)
    await tick()
    check(
        button("Sync").getAttribute("aria-busy") === "false" &&
            !button("Sync").disabled,
        "refresh settlement clears optimistic state",
    )
    dispose()
    document.getElementById("results")!.textContent =
        results.join("\n") + "\nALL CHECKS PASSED"
}
void run().catch(
    (error) =>
        (document.getElementById("results")!.textContent =
            results.join("\n") + `\nFAIL: ${error.stack ?? error}`),
)
