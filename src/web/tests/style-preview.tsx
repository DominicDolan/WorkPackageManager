/** Read-only visual fixture: real screens, representative data, no server writes. */
import { render } from "@solidjs/web"
import { App } from "../src/App/App"
import { api } from "../src/api"
import "../src/styles.css"

const date = "2026-09-16T10:00:00Z"
const task = {
    id: 1,
    ref: "T-1",
    title: "Create a shared vocabulary for cards and controls",
    description:
        "Use semantic elements and appearance variants across the workspace. Keep page layout close to its markup.",
    status: "in_progress",
    priority: "high",
    position: 0,
    tags: ["frontend"],
    estimateUnits: 1,
    investigationRef: "INV-1",
    recommendedTier: null,
    workPackageRef: "WP-1",
    dependsOn: [],
    blocks: [],
    useGitWorkflow: true,
    branchName: "task/shared-style",
    targetBranches: ["feature/shared-style"],
    checkpointName: null,
    createdAt: date,
    updatedAt: date,
    startedAt: date,
    devCompletedAt: null,
    verifiedAt: null,
    closedAt: null,
    events: [],
    runs: [],
    attachments: [],
    notes: [],
}
const tasks = [
    task,
    {
        ...task,
        id: 2,
        ref: "T-2",
        title: "Review mobile layouts and keyboard focus",
        status: "dev_complete",
        devCompletedAt: date,
    },
]
const note = {
    path: "design/style-guide.md",
    title: "Design conventions",
    tags: ["design"],
    folder: "design",
    excerpt: "Elements describe content; variants describe appearance.",
    createdAt: date,
    updatedAt: date,
    attachments: [],
    body: "## A shared visual vocabulary\n\nUse **semantic HTML** with a small set of variants.\n\n- Cards use `article`\n- Actions use native buttons\n- Layout stays in utilities\n\n> States belong in attributes.\n\n[Read the guide](https://example.com)\n\n| Element | Variant |\n| --- | --- |\n| article | tonal |\n\n```css\narticle.tonal { background: var(--paper); }\n```",
}
const investigation = {
    id: 1,
    ref: "INV-1",
    title: "Audit recurring interface patterns",
    brief: "Find the shared card, form, navigation, and typography patterns.",
    findings:
        "Cards and action controls can share their surface rules. Keep the delivery-check layout local.",
    status: "complete",
    workPackageRef: "WP-1",
    createdAt: date,
    updatedAt: date,
    startedAt: date,
    completedAt: date,
    tasks,
    notes: [note],
}
const git = {
    exists: true,
    merged: false,
    aheadOfBase: 2,
    filesChanged: 4,
    dirty: false,
    commits: [
        {
            sha: "abc123456",
            shortSha: "abc1234",
            subject: "Consolidate shared surfaces",
            author: "Developer",
            date,
        },
    ],
}
const workPackage = {
    id: 1,
    ref: "WP-1",
    name: "A clearer, more consistent workspace",
    brief: "Consolidate shared styling while preserving the focused work-package, task, and reference-note views.",
    branchNames: ["feature/shared-style"],
    color: "#5b9dff",
    position: 0,
    createdAt: date,
    updatedAt: date,
    taskCount: 2,
    devCompleteCount: 1,
    openCount: 2,
    tasks,
    investigations: [investigation],
    branches: [
        {
            id: 1,
            workPackageRef: "WP-1",
            label: "Branch",
            branchName: "feature/shared-style",
            baseBranch: null,
            base: "main",
            origin: "new",
            taskRefs: tasks.map((t) => t.ref),
            createdAt: date,
            updatedAt: date,
            git,
            delivery: null,
        },
    ],
    notes: [note],
    queue: [task],
    outsideBlockers: [],
    inProgress: [task],
    baseBranch: "main",
    run: null,
    workRuns: [],
}
const branch = {
    branchName: "feature/shared-style",
    baseBranch: "main",
    taskRefs: tasks.map((t) => t.ref),
    createdAt: date,
    updatedAt: date,
    tasks,
    git,
    checksRunning: null,
    prTitle: "A shared styling vocabulary",
    prBody: note.body,
    prUrl: null,
    checks: {
        branch: "feature/shared-style",
        base: "main",
        headSha: "abc123456",
        ranAt: date,
        passed: false,
        checks: [
            {
                name: "Typecheck",
                command: ["bun", "run", "typecheck"],
                status: "passed",
                durationMs: 540,
                output: "Types checked successfully.",
                exitCode: 0,
            },
            {
                name: "Visual review",
                command: ["review"],
                status: "failed",
                durationMs: 920,
                output: "Review the changed screenshots.",
                exitCode: 1,
            },
        ],
    },
}
const notesWorkspace = {
    dir: "/preview/notes",
    exists: true,
    autoCommit: false,
    git: {
        repo: false,
        branch: null,
        dirty: 0,
        lastCommit: null,
        upstream: null,
        unpushed: null,
    },
}
const issue = {
    id: "issues/demo.json#0",
    path: "issues/demo.json",
    source: "github",
    key: "#42",
    title: "Use consistent surfaces across detail pages",
    state: "open",
    stateLabel: "Open",
    url: null,
    container: "example/workspace",
    kind: "Feature",
    labels: [{ name: "design", color: null }],
    author: null,
    assignees: [],
    createdAt: date,
    updatedAt: date,
    closedAt: null,
    commentCount: 2,
    milestone: null,
    fetchedAt: date,
    excerpt: "Unify cards, notices, and form controls.",
    bodyFormat: "markdown",
    body: "Use the same vocabulary on every screen.",
    raw: { number: 42, state: "open" },
}

// All API methods reject unless supplied below, including mutation methods.
for (const key of Object.keys(api) as (keyof typeof api)[]) {
    Object.assign(api, {
        [key]: async () => {
            throw new Error("This preview uses read-only fixture data.")
        },
    })
}
function fixture(key: keyof typeof api, value: unknown) {
    Object.assign(api, { [key]: async () => structuredClone(value) })
}
fixture("listWorkPackages", [workPackage])
fixture("listTasks", tasks)
fixture("getTask", { ...task, notes: [note] })
fixture("getWorkPackage", workPackage)
fixture("listInvestigations", [investigation])
fixture("getInvestigation", investigation)
fixture("listBranches", {
    branches: [branch],
    currentBranch: "main",
    localBranches: ["main", "feature/shared-style"],
})
fixture("meta", {
    aioVrInstalled: false,
    aioVrWorkspaceExists: false,
    tools: {
        checkCount: 2,
        checkNames: ["Typecheck", "Visual review"],
        prAgentAvailable: false,
    },
})
fixture("listNotes", {
    notes: [note],
    folders: ["design"],
    tags: ["design"],
    workspace: notesWorkspace,
})
fixture("getNote", note)
fixture("listIssues", {
    issues: [issue],
    notes: notesWorkspace,
    facets: { sources: ["github"], labels: ["design"], total: 1 },
})
fixture("getIssue", issue)
fixture("agentEnvironment", {
    harnesses: [],
    terminalAvailable: false,
    permissionModes: [],
    models: [],
})
fixture("listAgentRuns", [])
// Avoid connecting to the real workspace's event stream from the fixture.
window.EventSource = class extends EventTarget {
    close() {}
} as unknown as typeof EventSource
render(() => <App />, document.getElementById("root")!)
