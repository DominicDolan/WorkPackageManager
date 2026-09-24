/** Isolated browser regression checks. All branch requests are in-memory. */
import { render } from "@solidjs/web"
import { createSignal } from "solid-js"
import type {
    CombinedBranchDetail,
    WorkPackageBranchDetail,
    WorkPackageDetail,
} from "@shared/types"
import { api } from "../src/api"
import { WorkPackageWorkspace } from "../src/WorkPackageWorkspace/WorkPackageWorkspace"
import styles from "../src/WorkPackageWorkspace/WorkPackageWorkspace.module.css"
import "../src/styles.css"

const git = { exists: true, commits: [], filesChanged: 0 }
const initial = {
    branchName: "test/loading",
    git,
    updatedAt: "initial",
    checks: null,
    checksRunning: null,
    checksSupervision: null,
} as unknown as CombinedBranchDetail
let latest = initial
let update: (value: CombinedBranchDetail) => void
let startChecks: () => void
api.getBranch = async () => latest
api.getChecks = async () => ({
    checks: latest.checks,
    checksRunning: latest.checksRunning,
    checksSupervision: latest.checksSupervision,
})
api.getWorkPackage = async () =>
    ({
        ref: "WP-1",
        name: "Check progress fixture",
        tasks: [],
        investigations: [],
        workRuns: [],
        queue: [],
        outsideBlockers: [],
        inProgress: [],
        run: null,
        branches: [
            {
                id: 1,
                branchName: initial.branchName,
                label: "Branch",
                base: "main",
                git,
                taskRefs: [],
                createdAt: "2026-09-21T12:00:00Z",
            } as unknown as WorkPackageBranchDetail,
        ],
    }) as unknown as WorkPackageDetail
api.runChecks = async () => {
    await new Promise<void>((resolve) => (startChecks = resolve))
    return (latest = {
        ...latest,
        updatedAt: "started",
        checksRunning: {
            branch: initial.branchName,
            base: "main",
            startedAt: new Date().toISOString(),
            current: "Typecheck",
            currentStartedAt: new Date().toISOString(),
            names: ["Typecheck", "Tests"],
            done: 0,
            total: 2,
            checks: [],
        },
    })
}
function Fixture() {
    const [branch, setBranch] = createSignal(initial)
    const [revision, setRevision] = createSignal(0)
    update = (value) => {
        setBranch(value)
        setRevision((value) => value + 1)
    }
    return (
        <div class={styles.scope}>
            <div id="samples" class="grid gap-3 p-4">
                <article class="tonal p-4" aria-busy="true">
                    Loading article
                </article>
                <button class="primary" disabled aria-busy="true">
                    Save
                </button>
                <input
                    class="inset"
                    aria-label="Loading input"
                    aria-busy="true"
                />
                <ul>
                    <li aria-busy="true">Loading item</li>
                </ul>
            </div>
            <WorkPackageWorkspace
                workPackageRef="WP-1"
                snapshot={{
                    workPackages: [],
                    tasks: [],
                    investigations: [],
                    branches: [branch()],
                    currentBranch: initial.branchName,
                    localBranches: [],
                    aioVrReady: false,
                    tools: {
                        checkCount: 2,
                        checkNames: ["Typecheck", "Tests"],
                        prAgentAvailable: false,
                        prAgent: null,
                        gh: false,
                        ghAuthed: false,
                    },
                }}
                changed={() => {}}
                revision={revision()}
                back={() => {}}
                openTask={() => {}}
            />
        </div>
    )
}
const results: string[] = []
function check(value: unknown, label: string) {
    if (!value) throw new Error(label)
    results.push(`PASS: ${label}`)
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 100))
const rows = () => [
    ...document.querySelectorAll<HTMLLIElement>(".branch-checks li"),
]
const busyRows = () =>
    rows().filter((row) => row.getAttribute("aria-busy") === "true")
async function run() {
    render(() => <Fixture />, document.getElementById("root")!)
    await tick()
    for (const el of document.querySelectorAll<HTMLElement>(
        "#samples [aria-busy]",
    )) {
        const style = getComputedStyle(el)
        check(
            style.backgroundImage.includes("linear-gradient") &&
                style.backgroundSize.endsWith("3px"),
            `${el.tagName}: bottom loading line`,
        )
        check(
            style.animationName ===
                (matchMedia("(prefers-reduced-motion: reduce)").matches
                    ? "none"
                    : "busy-line"),
            `${el.tagName}: motion preference`,
        )
    }
    const sample = document.querySelector<HTMLButtonElement>("#samples button")!
    check(
        getComputedStyle(sample).opacity === "1",
        "busy disabled button remains legible",
    )
    const width = sample.getBoundingClientRect().width
    sample.setAttribute("aria-busy", "false")
    check(
        getComputedStyle(sample).backgroundImage === "none" &&
            width === sample.getBoundingClientRect().width,
        "idle clears indicator without layout shift",
    )
    check(rows().length === 2, "unrun checks are listed")
    const editor = document.querySelector<HTMLTextAreaElement>("textarea")!
    editor.value = "Unsaved description\n".repeat(40)
    editor.dispatchEvent(new Event("input", { bubbles: true }))
    await tick()
    editor.scrollTop = 100
    const editorScroll = editor.scrollTop
    const firstRow = rows()[0]
    const rowTop = firstRow.getBoundingClientRect().top
    const runAll = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.trim() === "Run all checks")!
    runAll.click()
    await tick()
    check(
        busyRows().length === 1 &&
            busyRows()[0].textContent?.includes("Typecheck"),
        "requested row is busy before the server responds",
    )
    startChecks()
    await tick()
    check(
        editor === document.querySelector("textarea") &&
            editor.scrollTop === editorScroll,
        "starting checks preserves the editor and its scroll position",
    )
    check(
        firstRow === rows()[0] &&
            rows()[0].getBoundingClientRect().top === rowTop,
        "starting checks preserves rows without shifting the card",
    )
    const timer = rows()[0].querySelector('[role="timer"]')!
    const elapsed = timer.textContent
    await new Promise((resolve) => setTimeout(resolve, 1100))
    check(
        timer.textContent !== elapsed,
        "running check timer advances before completion",
    )
    check(rows().length === 2, "first run retains all checks")
    check(
        busyRows().length === 1 &&
            busyRows()[0].textContent?.includes("Typecheck"),
        "only current check is busy",
    )
    check(
        [
            ...document.querySelectorAll<HTMLButtonElement>(
                ".check-run-button",
            ),
        ].every((b) => b.disabled),
        "check run buttons locked during suite",
    )
    check(
        document
            .querySelector('button[aria-busy="true"]')
            ?.textContent?.trim() === "Run all checks",
        "run action label stays stable",
    )
    latest = {
        ...latest,
        updatedAt: "next",
        checksRunning: {
            ...latest.checksRunning!,
            current: "Tests",
            done: 1,
            checks: [
                {
                    name: "Typecheck",
                    command: ["test"],
                    cwd: ".",
                    status: "passed",
                    durationMs: 10,
                    output: "",
                    exitCode: 0,
                },
            ],
        },
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    check(
        busyRows().length === 1 && busyRows()[0].textContent?.includes("Tests"),
        "indicator follows progress",
    )
    check(
        rows()
            .find((row) => row.textContent?.includes("Typecheck"))
            ?.textContent?.includes("Passed"),
        "completed checks show their result while the suite continues",
    )
    const completedTime = rows()[0].querySelector(
        '[aria-label="Typecheck elapsed time"]',
    )!.textContent
    await new Promise((resolve) => setTimeout(resolve, 1100))
    check(
        rows()[0].querySelector('[aria-label="Typecheck elapsed time"]')!
            .textContent === completedTime,
        "completed timer stops while the next check runs",
    )
    check(
        editor === document.querySelector("textarea") &&
            editor.scrollTop === editorScroll,
        "progress polling preserves editor scroll",
    )
    latest = {
        ...latest,
        updatedAt: "finished",
        checksRunning: null,
        checksSupervision: null,
        checks: {
            branch: initial.branchName,
            base: "main",
            headSha: null,
            ranAt: new Date().toISOString(),
            passed: true,
            ranOnBranch: initial.branchName,
            checks: ["Typecheck", "Tests"].map((name) => ({
                name,
                command: ["test"],
                cwd: "/fixture",
                status: "passed" as const,
                durationMs: 10,
                output: "Previous output",
                exitCode: 0,
            })),
        },
    }
    update(latest)
    await tick()
    check(
        rows().length === 2 && busyRows().length === 0,
        "completion clears busy rows and keeps results",
    )
    check(
        editor === document.querySelector("textarea") &&
            editor.value.startsWith("Unsaved description"),
        "delivery refresh preserves the editor and unsaved draft",
    )
    latest = {
        ...latest,
        updatedAt: "rerun",
        checksRunning: {
            branch: initial.branchName,
            base: "main",
            startedAt: new Date().toISOString(),
            current: "Tests",
            done: 0,
            currentStartedAt: new Date().toISOString(),
            names: ["Tests"],
            total: 1,
            checks: [],
        },
    }
    update(latest)
    await tick()
    check(
        rows().length === 2 &&
            busyRows().length === 1 &&
            busyRows()[0].textContent?.includes("Previous output"),
        "single rerun retains previous report and output",
    )
    check(
        getComputedStyle(busyRows()[0], "::after").backgroundImage.includes(
            "linear-gradient",
        ),
        "running row owns a visible loading overlay",
    )
    latest = { ...latest, updatedAt: "idle-again", checksRunning: null }
    update(latest)
    await tick()
    let rejectStart!: (error: Error) => void
    api.runChecks = () => new Promise((_, reject) => (rejectStart = reject))
    rows()
        .find((row) => row.textContent?.includes("Tests"))!
        .querySelector("button")!
        .click()
    await tick()
    check(
        busyRows().length === 1 && busyRows()[0].textContent?.includes("Tests"),
        "single-check request immediately marks its own row",
    )
    rejectStart(new Error("Unable to start checks"))
    await tick()
    check(
        busyRows().length === 0 &&
            document.body.textContent?.includes("Unable to start checks"),
        "failed check request clears the optimistic row and reports the error",
    )
    latest = {
        ...latest,
        updatedAt: "paused",
        checks: {
            ...latest.checks!,
            passed: false,
            checks: latest.checks!.checks.map((run) =>
                run.name === "Tests"
                    ? { ...run, status: "failed", output: "Fix this check" }
                    : run,
            ),
        },
    }
    update(latest)
    await tick()
    const failedRow = rows()[1]
    failedRow.querySelector("details")!.open = true
    let resumed = false
    api.runChecks = async (_name, check, resume) => {
        resumed = !check && resume === true
        return (latest = {
            ...latest,
            checksRunning: {
                branch: initial.branchName,
                base: "main",
                startedAt: new Date().toISOString(),
                currentStartedAt: new Date().toISOString(),
                current: "Tests",
                names: ["Tests"],
                done: 0,
                total: 1,
                checks: [latest.checks!.checks[0]],
            },
        })
    }
    const resume = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Resume checks")!
    check(!!resume && !resume.disabled, "paused suite offers Resume checks")
    resume.click()
    await tick()
    check(
        resumed && busyRows()[0] === failedRow,
        "Resume retries the failed check in place",
    )
    check(
        rows()[0].textContent?.includes("Passed"),
        "Resume retains successful rows",
    )
    check(
        failedRow.querySelector("details")!.open,
        "expanded output survives starting a new check",
    )
    check(
        editor === document.querySelector("textarea") &&
            editor.scrollTop === editorScroll,
        "Resume preserves the PR editor and scrollbar",
    )
    latest = {
        ...latest,
        checksRunning: {
            ...latest.checksRunning!,
            names: ["Typecheck", "Tests"],
            total: 2,
            done: 1,
            checks: [
                {
                    ...latest.checks!.checks[0],
                    durationMs: 2345,
                    output: "Fresh result",
                },
            ],
        },
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    check(
        rows()[0].textContent?.includes("2.3s") &&
            rows()[0].textContent?.includes("Fresh result"),
        "partial rerun results replace old results before the suite finishes",
    )
    check(
        rows()[1] === failedRow && failedRow.querySelector("details")!.open,
        "polling retains expanded output and row identity",
    )
    document.getElementById("results")!.textContent =
        results.join("\n") + "\nALL CHECKS PASSED"
}
void run().catch(
    (error) =>
        (document.getElementById("results")!.textContent =
            results.join("\n") + `\nFAIL: ${error.stack ?? error}`),
)
