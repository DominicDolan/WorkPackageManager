/** Deferred, in-memory reads exercise real components without server access. */
import { render } from "@solidjs/web"
import { createSignal, isPending } from "solid-js"
import type {
    AgentEnvironment,
    AgentModel,
    Note,
    IssueDetail,
    TaskDetail,
} from "@shared/types"
import type { WorkspaceSnapshot } from "../src/types/workspace"
import { TaskWorkspace } from "../src/TaskWorkspace/TaskWorkspace"
import { api } from "../src/api"
import { AgentSettings } from "../src/components/AgentSettings"
import { NotesWorkspace } from "../src/NotesWorkspace/NotesWorkspace"
import { IssuesWorkspace } from "../src/IssuesWorkspace/IssuesWorkspace"
import "../src/styles.css"

for (const key of Object.keys(api))
    Object.assign(api, {
        [key]: async () => {
            throw new Error(`Unexpected API call: ${key}`)
        },
    })
const root = document.getElementById("root")!
const results: string[] = []
const tick = () => new Promise((resolve) => setTimeout(resolve, 80))
function check(value: unknown, message: string) {
    if (!value) throw new Error(message)
    results.push(`PASS: ${message}`)
}
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}
function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
    el.value = value
    el.dispatchEvent(
        new Event(el.tagName === "SELECT" ? "change" : "input", {
            bubbles: true,
        }),
    )
}
const workspace = {
    dir: "/fixture",
    exists: true,
    autoCommit: false,
    git: {
        repo: false,
        upstream: null,
        branch: null,
        dirty: 0,
        lastCommit: null,
        unpushed: null,
    },
}
const note = (path: string, title: string) =>
    ({
        path,
        title,
        body: `Content for ${title}`,
        tags: [],
        folder: "",
        excerpt: title,
    }) as unknown as Note
const one = note("one.md", "First note")
const two = note("two.md", "Second note")
async function run() {
    const first = deferred<Awaited<ReturnType<typeof api.listNotes>>>()
    const searchA = deferred<Awaited<ReturnType<typeof api.listNotes>>>()
    const searchB = deferred<Awaited<ReturnType<typeof api.listNotes>>>()
    const detail = deferred<Note>()
    const listing = {
        notes: [one, two],
        folders: ["design"],
        tags: ["tag"],
        workspace,
    }
    api.listNotes = (options) =>
        options?.q === "a"
            ? searchA.promise
            : options?.q === "ab"
              ? searchB.promise
              : first.promise
    api.getNote = async (path) => (path === one.path ? one : detail.promise)
    let revise!: (value: number) => void
    let dispose = render(() => {
        const [revision, setRevision] = createSignal(0)
        revise = setRevision
        return (
            <NotesWorkspace
                select={() => {}}
                revision={revision()}
                initialPath={one.path}
            />
        )
    }, root)
    await tick()
    check(
        !root.querySelector('input[type="search"]'),
        "notes initial fetch uses its Loading fallback",
    )
    first.resolve(listing)
    await tick()
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!
    change(search, "a")
    await tick()
    check(
        search.value === "a" &&
            root.querySelector(".note-list")?.getAttribute("aria-busy") ===
                "true",
        "notes search reflects latest query and marks results busy",
    )
    check(
        root.textContent?.includes("First note"),
        "notes retain previous results during search",
    )
    change(search, "ab")
    await tick()
    searchB.resolve({ ...listing, notes: [two] })
    await tick()
    check(
        root
            .querySelector(".note-list")
            ?.textContent?.includes("Second note") &&
            root.querySelector(".note-list")?.getAttribute("aria-busy") ===
                "false",
        "latest search result settles",
    )
    searchA.resolve({ ...listing, notes: [one] })
    await tick()
    check(
        !root.querySelector(".note-list")?.textContent?.includes("First note"),
        "late search response cannot overwrite the latest results",
    )
    root.querySelector<HTMLButtonElement>(".note-list button")!.click()
    await tick()
    check(
        root.querySelector(".note-list button")?.getAttribute("aria-busy") ===
            "true",
        "requested note row shows loading immediately",
    )
    check(
        root.querySelector(".detail [inert]") &&
            root.textContent?.includes("Content for First note"),
        "previous note stays visible but inert while switching",
    )
    detail.resolve(two)
    await tick()
    check(
        !root.querySelector(".detail [inert]") &&
            root.textContent?.includes("Content for Second note"),
        "settled note becomes interactive",
    )
    const reload = deferred<typeof listing>()
    api.listNotes = () => reload.promise
    revise(1)
    await tick()
    check(
        root.querySelector(".note-list")?.getAttribute("aria-busy") === "false",
        "same-query background refresh stays quiet",
    )
    reload.resolve(listing)
    await tick()
    dispose()

    const issue = {
        id: "issue-1",
        title: "Example issue",
        source: "github",
        key: "#1",
        state: "open",
        stateLabel: "Open",
        labels: [],
        assignees: [],
        body: "Issue details",
        bodyFormat: "markdown",
        raw: {},
        commentCount: 0,
    } as unknown as IssueDetail
    const issues = {
        issues: [issue],
        facets: { sources: [], labels: [], total: 1 },
        notes: workspace,
    }
    const issueSearch = deferred<typeof issues>()
    const issueDetail = deferred<IssueDetail>()
    api.listIssues = async (options) =>
        options?.q ? issueSearch.promise : issues
    api.getIssue = () => issueDetail.promise
    dispose = render(
        () => <IssuesWorkspace select={() => {}} revision={0} />,
        root,
    )
    await tick()
    change(root.querySelector<HTMLInputElement>("input")!, "example")
    await tick()
    check(
        root.querySelector<HTMLInputElement>("input")!.value === "example" &&
            root.querySelector('.detail [aria-busy="true"]'),
        "issue search retains latest text with pending results",
    )
    issueSearch.resolve(issues)
    await tick()
    root.querySelector<HTMLButtonElement>(".detail button.card-item")!.click()
    await tick()
    check(
        root
            .querySelector(".detail button.card-item")
            ?.getAttribute("aria-busy") === "true",
        "requested issue card shows pending state",
    )
    issueDetail.resolve(issue)
    await tick()
    check(
        !root.querySelector('.detail [aria-busy="true"]') &&
            root.textContent?.includes("Issue details"),
        "issue details settle and clear pending state",
    )
    dispose()

    const task = (ref: string) =>
        ({
            ref,
            title: `Task ${ref}`,
            status: "backlog",
            priority: "medium",
            description: "",
            tags: [],
            notes: [],
            events: [],
            runs: [],
            attachments: [],
            dependsOn: [],
            blocks: [],
            workPackageRef: null,
            estimateUnits: 1,
            updatedAt: new Date().toISOString(),
        }) as unknown as TaskDetail
    const firstTask = task("T-1")
    const secondTask = task("T-2")
    const nextTask = deferred<TaskDetail>()
    api.getTask = async (ref) => (ref === "T-1" ? firstTask : nextTask.promise)
    api.listNotes = async () => listing
    dispose = render(() => {
        const [ref, setRef] = createSignal("T-1")
        return (
            <TaskWorkspace
                workPackageRef="__unassigned__"
                taskRef={ref()}
                snapshot={
                    {
                        tasks: [firstTask, secondTask],
                        workPackages: [],
                    } as unknown as WorkspaceSnapshot
                }
                back={() => {}}
                openTask={setRef}
                openNote={() => {}}
                changed={() => {}}
                revision={0}
            />
        )
    }, root)
    await tick()
    const nextButton = [
        ...root.querySelectorAll<HTMLButtonElement>(".task-nav-item"),
    ].find((el) => el.textContent?.includes("T-2"))!
    nextButton.click()
    await tick()
    check(
        nextButton.getAttribute("aria-current") === "page" &&
            nextButton.getAttribute("aria-busy") === "true",
        "requested task navigation item highlights immediately and shows pending",
    )
    check(
        root
            .querySelector("[inert] article")
            ?.textContent?.includes("Task T-1"),
        "previous task remains visible but cannot be edited during navigation",
    )
    nextTask.resolve(secondTask)
    await tick()
    check(
        !root.querySelector("[inert]") &&
            root
                .querySelector("article.document")
                ?.textContent?.includes("Task T-2"),
        "task detail becomes interactive when the requested task settles",
    )
    dispose()

    const requests = {
        alpha: deferred<AgentModel[]>(),
        beta: deferred<AgentModel[]>(),
        gamma: deferred<AgentModel[]>(),
    }
    api.agentModels = (harness) =>
        requests[harness as keyof typeof requests].promise
    const environment = {
        harnesses: Object.keys(requests).map((id) => ({
            id,
            label: id,
            available: true,
        })),
        modelTiers: {},
        terminalAvailable: true,
    } as unknown as AgentEnvironment
    dispose = render(() => {
        const [harness, setHarness] = createSignal("alpha")
        const [model, setModel] = createSignal("")
        return (
            <>
                <AgentSettings
                    environment={environment}
                    harness={harness()}
                    setHarness={setHarness}
                    model={model()}
                    setModel={setModel}
                    mode="terminal"
                    setMode={() => {}}
                    permission="manual"
                    setPermission={() => {}}
                    unattended={false}
                />
                <button id="launch" disabled={isPending(harness)}>
                    Start run
                </button>
            </>
        )
    }, root)
    await tick()
    check(
        root.querySelector<HTMLInputElement>('[role="combobox"]')?.disabled,
        "initial model catalogue has a disabled loading control",
    )
    requests.alpha.resolve([
        { id: "alpha-model", label: "Alpha model" } as AgentModel,
    ])
    await tick()
    change(root.querySelector<HTMLInputElement>('[role="combobox"]')!, "")
    await tick()
    check(
        root.textContent?.includes("Alpha model"),
        "resolved catalogue offers models",
    )
    change(root.querySelector("select")!, "beta")
    await tick()
    check(
        root.querySelector("select")!.value === "beta" &&
            root.querySelector<HTMLInputElement>('[role="combobox"]')!.disabled,
        "harness selection updates immediately while models load",
    )
    check(
        root.querySelector<HTMLButtonElement>("#launch")!.disabled,
        "pending harness selection prevents launching with stale settings",
    )
    check(
        !root.textContent?.includes("Alpha model") &&
            root
                .querySelector<HTMLInputElement>('[role="combobox"]')!
                .value.includes("beta"),
        "stale catalogue hidden and default label follows requested harness",
    )
    change(root.querySelector("select")!, "gamma")
    await tick()
    requests.gamma.resolve([
        { id: "gamma-model", label: "Gamma model" } as AgentModel,
    ])
    await tick()
    requests.beta.resolve([
        { id: "beta-model", label: "Beta model" } as AgentModel,
    ])
    await tick()
    change(root.querySelector<HTMLInputElement>('[role="combobox"]')!, "")
    await tick()
    check(
        root.textContent?.includes("Gamma model") &&
            !root.textContent?.includes("Beta model"),
        "late model response cannot replace the requested harness catalogue",
    )
    // A failed catalogue preserves the deliberate harness-default fallback.
    requests.beta = deferred()
    change(root.querySelector("select")!, "beta")
    await tick()
    requests.beta.reject(new Error("Catalogue unavailable"))
    await tick()
    check(
        !root.querySelector<HTMLInputElement>('[role="combobox"]')!.disabled &&
            root
                .querySelector<HTMLInputElement>('[role="combobox"]')!
                .value.includes("beta"),
        "catalogue failure restores an enabled harness-default picker",
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
