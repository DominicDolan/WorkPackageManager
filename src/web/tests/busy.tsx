/** Isolated browser regression checks. All branch requests are in-memory. */
import { render } from "@solidjs/web"
import { createSignal } from "solid-js"
import type { CombinedBranchDetail, WorkPackageDetail } from "@shared/types"
import { api } from "../src/api"
import { BranchPanel } from "../src/WorkPackageWorkspace/BranchPanel"
import styles from "../src/WorkPackageWorkspace/WorkPackageWorkspace.module.css"
import "../src/styles.css"

const git = { exists: true, commits: [], filesChanged: 0 }
const initial = {
    branchName: "test/loading",
    git,
    updatedAt: "initial",
    checks: null,
    checksRunning: null,
} as unknown as CombinedBranchDetail
let latest = initial
let update: (value: CombinedBranchDetail) => void
let startChecks: () => void
api.getBranch = async () => latest
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
            done: 0,
            total: 2,
        },
    })
}
function Fixture() {
    const [branch, setBranch] = createSignal(initial)
    update = setBranch
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
            <BranchPanel
                workPackage={
                    {
                        branchName: initial.branchName,
                        git,
                    } as unknown as WorkPackageDetail
                }
                branch={branch()}
                tools={{
                    checkCount: 2,
                    checkNames: ["Typecheck", "Tests"],
                    prAgentAvailable: false,
                    prAgent: null,
                    gh: false,
                    ghAuthed: false,
                }}
                changed={() => {}}
                workPackageChanged={() => {}}
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
        checksRunning: { ...latest.checksRunning!, current: "Tests", done: 1 },
    }
    update(latest)
    await tick()
    check(
        busyRows().length === 1 && busyRows()[0].textContent?.includes("Tests"),
        "indicator follows progress",
    )
    latest = {
        ...latest,
        updatedAt: "finished",
        checksRunning: null,
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
    latest = {
        ...latest,
        updatedAt: "rerun",
        checksRunning: {
            branch: initial.branchName,
            base: "main",
            startedAt: new Date().toISOString(),
            current: "Tests",
            done: 0,
            total: 1,
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
    document.getElementById("results")!.textContent =
        results.join("\n") + "\nALL CHECKS PASSED"
}
void run().catch(
    (error) =>
        (document.getElementById("results")!.textContent =
            results.join("\n") + `\nFAIL: ${error.stack ?? error}`),
)
