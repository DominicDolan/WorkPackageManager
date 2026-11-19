import type {
    AgentCommand,
    AgentEnvironment,
    AgentModel,
    AgentPermissionMode,
    AgentRun,
    AgentRunDetail,
    AgentRunMode,
    WorkPackageRun,
    BranchCommit,
    CombinedBranchDetail,
    WorkPackageAdvanceOutcome,
    Investigation,
    InvestigationDetail,
    InvestigationStatus,
    IssueDetail,
    IssueState,
    IssueListItem,
    Note,
    NoteAttachment,
    NoteListItem,
    GitConflict,
    NotesGitInfo,
    NotesWorkspaceInfo,
    ModelTier,
    Priority,
    Status,
    Task,
    TaskAttachment,
    TaskDetail,
    TaskVisualSync,
    TranscriptDetail,
    TranscriptSummary,
    TranscriptLink,
    WorkPackage,
    BaselineReport,
    WorkPackageBranchDetail,
    BranchTaskSync,
    WorkPackageDetail,
    RebaseSupervision,
    PipelinePlan,
    PipelineResumeSettings,
    RunSupervisor,
    WorkRunDetail,
    WorkRunKind,
    WorkPackageSummary,
    ToolAvailability,
    ChangeChannel,
    ChangeEvent,
} from "@work-task-manager/shared"
import { subscribeToChanges } from "./events"

/** A branch as it is described when creating one. Every field is optional:
 *  left out, the server names it from the work package, cuts it from the base
 *  branch, and gives it every task not yet Dev Complete. */
export interface NewBranchInput {
    label?: string
    branchName?: string
    /** Adopt `branchName`, which already exists, rather than create it. */
    existing?: boolean
    baseBranch?: string | null
    taskRefs?: string[]
}

export interface Meta {
    statuses: Status[]
    priorities: Priority[]
    repoRoot: string
    aioVrDir: string
    aioVrInstalled: boolean
    aioVrWorkspaceExists: boolean
    /** Where the notes live and what state that folder is in. */
    notes: NotesWorkspaceInfo
    /** Which external CLIs the Branches view can use. */
    tools: ToolAvailability
}

/** The Issues view's payload: the cards, plus what the filters can offer. */
export interface IssueListing {
    issues: IssueListItem[]
    facets: {
        sources: { source: string; count: number }[]
        labels: string[]
        total: number
    }
    notes: NotesWorkspaceInfo
}

/** The Notes sidebar's whole payload: one read gives the list and its filters. */
export interface NoteListing {
    notes: NoteListItem[]
    folders: string[]
    tags: string[]
    workspace: NotesWorkspaceInfo
}

/** The part of `fetch` this client uses. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
    /**
     * Origin of the API server, e.g. `http://localhost:5199`. Empty (the
     * default) means "the page's own origin", which is right whenever the UI is
     * served by `tasks web` or proxied to it by a dev server.
     */
    baseUrl?: string
    /** Override `fetch`, e.g. to add headers or run outside a browser. */
    fetch?: FetchLike
}

/**
 * A typed client for every endpoint the API serves.
 *
 * Methods take what the server needs and resolve to the server's answer, with
 * errors thrown as `Error`s carrying the server's own message. Nothing here
 * depends on a UI framework.
 */
export function createClient(options: ClientOptions = {}) {
    const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "")
    const fetchImpl: FetchLike =
        options.fetch ?? ((input, init) => fetch(input, init))

    async function request<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await fetchImpl(`${baseUrl}/api${path}`, {
            ...init,
            headers: init?.body
                ? { "content-type": "application/json" }
                : undefined,
        })

        const payload = (await response.json().catch(() => null)) as
            (T & { error?: string }) | null

        if (!response.ok) {
            // The page is served off disk but the API is whatever process is running,
            // so a rebuilt UI can be talking to a server started before the endpoint
            // existed. That reads as an unexplained 404/405 on a brand-new route.
            // Matched on the routing errors specifically: a 404 also means "no task
            // with that ref", which is a real answer and must keep its own message.
            const unrouted =
                payload?.error === "Unknown endpoint." ||
                payload?.error === "Method not allowed."
            if (unrouted) {
                throw new Error(
                    `The running \`tasks web\` server does not have ${path} — it was started ` +
                        "before this version of the UI. Restart it and reload.",
                )
            }
            throw new Error(
                payload?.error ?? `Request failed (${response.status}).`,
            )
        }
        return payload as T
    }

    const api = {
        meta: () => request<Meta>("/meta"),

        listTranscripts: () =>
            request<{ transcripts: TranscriptSummary[] }>("/transcripts").then(
                (r) => r.transcripts,
            ),
        getTranscript: (path: string) =>
            request<{ transcript: TranscriptDetail }>(
                `/transcripts/${encodeURIComponent(path)}`,
            ).then((r) => r.transcript),
        addTranscriptLink: (path: string, link: TranscriptLink) =>
            request<{ transcript: TranscriptDetail }>(
                `/transcripts/${encodeURIComponent(path)}/links`,
                {
                    method: "POST",
                    body: JSON.stringify(link),
                },
            ).then((r) => r.transcript),
        removeTranscriptLink: (path: string, link: TranscriptLink) =>
            request<{ transcript: TranscriptDetail }>(
                `/transcripts/${encodeURIComponent(path)}/links`,
                {
                    method: "DELETE",
                    body: JSON.stringify(link),
                },
            ).then((r) => r.transcript),

        listTasks: (status?: Status) =>
            request<{ tasks: Task[] }>(
                `/tasks${status ? `?status=${status}` : ""}`,
            ).then((r) => r.tasks),

        /* ----------------------------------------------------------- baselines */

        /** The last `aio-vr run`, joined with what has been approved since. */
        baselines: () =>
            request<{ report: BaselineReport }>("/baselines").then(
                (r) => r.report,
            ),

        /** Re-drive the browser. No scenarios means the whole suite, which is slow —
         *  minutes, not seconds. A non-zero `exitCode` means something drifted, which
         *  is a result rather than a failure. */
        runBaselines: (scenarios: string[] = []) =>
            request<{
                report: BaselineReport
                exitCode: number
                output: string
            }>("/baselines/run", {
                method: "POST",
                body: JSON.stringify({ scenarios }),
            }),

        /** Promote one scenario's latest capture to be its baseline. */
        approveBaseline: (scenario: string) =>
            request<{ report: BaselineReport }>("/baselines/approve", {
                method: "POST",
                body: JSON.stringify({ scenario }),
            }).then((r) => r.report),

        /* -------------------------------------------------------------- work packages */

        listWorkPackages: () =>
            request<{ workPackages: WorkPackageSummary[] }>(
                "/work-packages",
            ).then((r) => r.workPackages),

        /** One work package, its tasks, the order they can be worked in, its
         *  investigations, and the live state of each of its branches. */
        getWorkPackage: (ref: string) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}`,
            ).then((r) => r.workPackage),

        createWorkPackage: (input: {
            name: string
            color?: string
            investigations?: { title?: string; brief?: string }[]
            branches?: NewBranchInput[]
        }) =>
            request<{
                workPackage: WorkPackage
                workPackages: WorkPackageSummary[]
            }>("/work-packages", {
                method: "POST",
                body: JSON.stringify(input),
            }),

        /** Write another investigation down in a work package. */
        addWorkPackageInvestigation: (
            ref: string,
            input: { title?: string; brief?: string },
        ) =>
            request<{
                investigation: InvestigationDetail
                workPackage: WorkPackageDetail
            }>(`/work-packages/${encodeURIComponent(ref)}/investigations`, {
                method: "POST",
                body: JSON.stringify(input),
            }),

        addWorkPackageBranch: (ref: string, input: NewBranchInput) =>
            request<{
                branch: WorkPackageBranchDetail
                workPackage: WorkPackageDetail
                git?: BranchTaskSync
            }>(`/work-packages/${encodeURIComponent(ref)}/branches`, {
                method: "POST",
                body: JSON.stringify(input),
            }),

        /** Rename a branch tab, rename its Git branch, or replace its tasks. */
        updateWorkPackageBranch: (
            ref: string,
            id: number,
            input: {
                label?: string
                branchName?: string
                baseBranch?: string | null
                taskRefs?: string[]
            },
        ) =>
            request<{
                branch: WorkPackageBranchDetail
                workPackage: WorkPackageDetail
                git?: BranchTaskSync
            }>(`/work-packages/${encodeURIComponent(ref)}/branches/${id}`, {
                method: "PATCH",
                body: JSON.stringify(input),
            }),

        /** Put an agent to work on a work package, as a new Run tab. */
        startWorkRun: (
            ref: string,
            input: {
                kind: WorkRunKind
                label?: string
                harness: string
                model: string
                mode: AgentRunMode
                permissionMode: AgentPermissionMode
                extra: string
                supervisor?: RunSupervisor | null
                fallback?: "stop" | "codex"
                /** A configured machine id. Omit for this computer. */
                machine?: string | null
                /** Start-to-finish runs only. */
                plan?: PipelinePlan
            },
        ) =>
            request<{ workRun: WorkRunDetail; workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/work-runs`,
                { method: "POST", body: JSON.stringify(input) },
            ),

        renameWorkRun: (ref: string, id: number, label: string) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/work-runs/${id}`,
                { method: "PATCH", body: JSON.stringify({ label }) },
            ),

        stopWorkRun: (ref: string, id: number) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/work-runs/${id}/stop`,
                { method: "POST" },
            ),

        /** Attach, change or (with null) remove an unattended run's supervisor. */
        setWorkRunSupervisor: (
            ref: string,
            id: number,
            supervisor: RunSupervisor | null,
        ) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/work-runs/${id}/supervisor`,
                { method: "PUT", body: JSON.stringify({ supervisor }) },
            ),

        /** Set a stopped unattended run going again from where it got to. */
        resumeWorkRun: (
            ref: string,
            id: number,
            settings?: PipelineResumeSettings,
        ) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/work-runs/${id}/resume`,
                {
                    method: "POST",
                    body: settings ? JSON.stringify(settings) : undefined,
                },
            ),

        /** Forget a Run tab. Its agent's own record is kept. */
        removeWorkRun: (ref: string, id: number) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/work-runs/${id}`,
                { method: "DELETE" },
            ),

        /** Forget a branch tab. The Git branch is left alone. */
        /** Rebase the branch onto its base's tip. A conflict aborts and is returned,
         *  not thrown, so the caller can offer it to an agent. */
        /** With a supervisor, conflicts go straight to it instead of coming back
         *  for the user to hand to an agent. */
        rebaseWorkPackageBranch: (
            ref: string,
            id: number,
            supervisor?: RunSupervisor,
        ) =>
            request<{
                rebased: boolean
                upToDate: boolean
                pushed: boolean
                conflict: GitConflict | null
                supervision: RebaseSupervision | null
                branch: WorkPackageBranchDetail
                workPackage: WorkPackageDetail
            }>(
                `/work-packages/${encodeURIComponent(ref)}/branches/${id}/rebase`,
                {
                    method: "POST",
                    body: JSON.stringify(supervisor ? { supervisor } : {}),
                },
            ),

        stopRebaseSupervisor: (ref: string, id: number) =>
            request<{ branch: WorkPackageBranchDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/branches/${id}/rebase-supervisor`,
                { method: "DELETE" },
            ),

        removeWorkPackageBranch: (ref: string, id: number) =>
            request<{ workPackage: WorkPackageDetail }>(
                `/work-packages/${encodeURIComponent(ref)}/branches/${id}`,
                { method: "DELETE" },
            ).then((r) => r.workPackage),

        updateWorkPackage: (
            ref: string,
            input: {
                name?: string
                color?: string
            },
        ) =>
            request<{ workPackages: WorkPackageSummary[]; tasks: Task[] }>(
                `/work-packages/${encodeURIComponent(ref)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify(input),
                },
            ),

        /** Deletes the organizing, never the tasks — the response says which ones were
         *  turned loose so the UI can say so too. */
        deleteWorkPackage: (ref: string) =>
            request<{
                deleted: string
                released: string[]
                workPackages: WorkPackageSummary[]
                tasks: Task[]
            }>(`/work-packages/${encodeURIComponent(ref)}`, {
                method: "DELETE",
            }),

        /** Sign a whole work package off at once: every Dev Complete task to Verified, or all
         *  the way to Closed. Unfinished work is left alone and one failure does not
         *  stop the rest, so the outcomes say what happened task by task. */
        advanceWorkPackage: (ref: string, status: "verified" | "closed") =>
            request<{
                workPackage: WorkPackageDetail
                outcomes: WorkPackageAdvanceOutcome[]
                workPackages: WorkPackageSummary[]
                tasks: Task[]
            }>(`/work-packages/${encodeURIComponent(ref)}/advance`, {
                method: "POST",
                body: JSON.stringify({ status }),
            }),

        reorderWorkPackages: (refs: string[]) =>
            request<{ workPackages: WorkPackageSummary[] }>(
                "/work-packages/reorder",
                {
                    method: "POST",
                    body: JSON.stringify({ refs }),
                },
            ).then((r) => r.workPackages),

        /** Move a task into a work package, or out of one with `null`.
         *
         *  `reposition: false` is what a drag sends: the drop already decided where
         *  the row goes, and letting the server also move it would fight the reorder
         *  that follows. Everything else wants the default, which keeps the work package's
         *  tasks together in the queue. */
        setWorkPackage: (
            ref: string,
            workPackageRef: string | null,
            reposition = true,
        ) =>
            request<{
                task: TaskDetail
                tasks: Task[]
                workPackages: WorkPackageSummary[]
            }>(`/tasks/${ref}/work-package`, {
                method: "POST",
                body: JSON.stringify({ workPackageRef, reposition }),
            }),

        getTask: (ref: string) =>
            request<{ task: TaskDetail }>(`/tasks/${ref}`).then((r) => r.task),

        createTask: (input: {
            title: string
            description?: string
            priority?: Priority
            recommendedTier?: ModelTier | null
            tags?: string[]
            useGitWorkflow?: boolean
            useVisualRegression?: boolean
            branchName?: string
            investigationRef?: string
            workPackageRef?: string | null
            dependsOn?: string[]
            estimateUnits?: number
        }) =>
            request<{ task: Task }>("/tasks", {
                method: "POST",
                body: JSON.stringify(input),
            }).then((r) => r.task),

        updateTask: (
            ref: string,
            input: {
                title?: string
                description?: string
                priority?: Priority
                recommendedTier?: ModelTier | null
                tags?: string[]
                useGitWorkflow?: boolean
                useVisualRegression?: boolean
                branchName?: string
                workPackageRef?: string | null
                dependsOn?: string[]
                estimateUnits?: number
            },
        ) =>
            request<{ task: TaskDetail }>(`/tasks/${ref}`, {
                method: "PATCH",
                body: JSON.stringify(input),
            }).then((r) => r.task),

        /** Make `ref` wait for each of `dependsOn`. Refused by the server if it would
         *  close a loop. */
        addDependencies: (ref: string, dependsOn: string[]) =>
            request<{ task: TaskDetail }>(`/tasks/${ref}/dependencies`, {
                method: "POST",
                body: JSON.stringify({ dependsOn }),
            }).then((r) => r.task),

        removeDependency: (ref: string, blockerRef: string) =>
            request<{ task: TaskDetail }>(
                `/tasks/${ref}/dependencies/${encodeURIComponent(blockerRef)}`,
                { method: "DELETE" },
            ).then((r) => r.task),

        deleteTask: (ref: string) =>
            request<{ deleted: string }>(`/tasks/${ref}`, { method: "DELETE" }),

        /** Rearrange `refs` into the order given. Only the positions those tasks
         *  already hold are redistributed, so passing a filtered subset is safe.
         *  Returns the full list as the server now orders it. */
        reorderTasks: (refs: string[]) =>
            request<{ tasks: Task[] }>("/tasks/reorder", {
                method: "POST",
                body: JSON.stringify({ refs }),
            }).then((r) => r.tasks),

        /** Move one task within its list: to the top or bottom, one step up or
         *  down, or directly before/after `otherRef`. Returns the full list. */
        moveTask: (
            ref: string,
            to: "top" | "bottom" | "up" | "down" | "before" | "after",
            otherRef?: string,
        ) =>
            request<{ tasks: Task[] }>(`/tasks/${ref}/move`, {
                method: "POST",
                body: JSON.stringify({ to, ref: otherRef }),
            }).then((r) => r.tasks),

        previewCombine: (refs: string[]) =>
            request<{
                base: string
                tasks: {
                    task: TaskDetail
                    exists: boolean
                    candidates: string[]
                    commits: BranchCommit[]
                }[]
            }>("/tasks/combine/preview", {
                method: "POST",
                body: JSON.stringify({ refs }),
            }),

        combineTasks: (
            refs: string[],
            branchName: string,
            closeTasks: boolean,
        ) =>
            request<{
                branchName: string
                tasks: TaskDetail[]
                conflicted: boolean
                base: {
                    branch: string
                    fetched: boolean
                    advanced: boolean
                    aheadOfRemote: boolean
                }
            }>("/tasks/combine", {
                method: "POST",
                body: JSON.stringify({ refs, branchName, closeTasks }),
            }),
        continueCombine: (branchName: string) =>
            request<{ branchName: string; tasks: TaskDetail[] }>(
                "/tasks/combine/continue",
                {
                    method: "POST",
                    body: JSON.stringify({ branchName }),
                },
            ),

        closeTask: (ref: string) =>
            request<{ task: TaskDetail }>(`/tasks/${ref}/close`, {
                method: "POST",
            }).then((r) => r.task),

        /** Moving to Dev Complete also merges the task into its work package's branch and
         *  registers it there. A conflict comes back as `mergeError` rather than as a
         *  failed request — the status change happened either way. */
        setStatus: (ref: string, status: Status, note?: string, merge = true) =>
            request<{ task: TaskDetail; mergeError: string | null }>(
                `/tasks/${ref}/status`,
                {
                    method: "POST",
                    body: JSON.stringify({ status, note, merge }),
                },
            ),

        /** The work package-branch merge on its own — after a skipped merge, or after a
         *  conflict has been resolved by hand. */
        mergeIntoWorkPackageBranch: (ref: string) =>
            request<{ task: TaskDetail; mergeError: string | null }>(
                `/tasks/${ref}/merge`,
                {
                    method: "POST",
                },
            ).then((r) => r.task),

        addNote: (ref: string, note: string) =>
            request<{ task: TaskDetail }>(`/tasks/${ref}/notes`, {
                method: "POST",
                body: JSON.stringify({ note }),
            }).then((r) => r.task),

        /** Upload one or more files against a task. Multipart, so no JSON body here —
         *  `request` would otherwise set a content-type that loses the boundary. */
        uploadTaskAttachments: async (ref: string, files: File[]) => {
            const form = new FormData()
            for (const file of files) form.append("file", file, file.name)

            const response = await fetchImpl(
                `${baseUrl}/api/tasks/${ref}/attachments`,
                {
                    method: "POST",
                    body: form,
                },
            )
            const payload = (await response.json().catch(() => null)) as {
                added: TaskAttachment[]
                task: TaskDetail
                error?: string
            } | null
            if (!response.ok || !payload)
                throw new Error(
                    payload?.error ?? `Upload failed (${response.status}).`,
                )
            return payload
        },

        deleteTaskAttachment: (ref: string, name: string) =>
            request<{ task: TaskDetail }>(
                `/tasks/${ref}/attachments/${encodeURIComponent(name)}`,
                {
                    method: "DELETE",
                },
            ).then((r) => r.task),

        capture: (ref: string, phase: "before" | "after") =>
            request<{ task: TaskDetail }>(`/tasks/${ref}/checkpoint/${phase}`, {
                method: "POST",
                body: JSON.stringify({}),
            }).then((r) => r.task),

        syncTaskVisuals: (ref: string) =>
            request<{ sync: TaskVisualSync }>(`/tasks/${ref}/checkpoint/sync`, {
                method: "POST",
            }).then((r) => r.sync),

        /* ------------------------------------------------------ investigations */

        listInvestigations: () =>
            request<{ investigations: Investigation[] }>(
                "/investigations",
            ).then((r) => r.investigations),

        getInvestigation: (ref: string) =>
            request<{ investigation: InvestigationDetail }>(
                `/investigations/${ref}`,
            ).then((r) => r.investigation),

        createInvestigation: (input: { title: string; brief?: string }) =>
            request<{ investigation: InvestigationDetail }>("/investigations", {
                method: "POST",
                body: JSON.stringify(input),
            }).then((r) => r.investigation),

        updateInvestigation: (
            ref: string,
            input: { title?: string; brief?: string; findings?: string },
        ) =>
            request<{ investigation: InvestigationDetail }>(
                `/investigations/${ref}`,
                {
                    method: "PATCH",
                    body: JSON.stringify(input),
                },
            ).then((r) => r.investigation),

        setInvestigationStatus: (ref: string, status: InvestigationStatus) =>
            request<{ investigation: InvestigationDetail }>(
                `/investigations/${ref}/status`,
                {
                    method: "POST",
                    body: JSON.stringify({ status }),
                },
            ).then((r) => r.investigation),

        deleteInvestigation: (ref: string) =>
            request<{ deleted: string }>(`/investigations/${ref}`, {
                method: "DELETE",
            }),

        /* ------------------------------------------------------------ branches */

        listBranches: () =>
            request<{
                branches: CombinedBranchDetail[]
                currentBranch: string | null
                localBranches: string[]
                defaultBase: string
            }>("/branches"),

        getBranch: (name: string) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}`,
            ).then((r) => r.branch),

        updateBranch: (
            name: string,
            input: {
                branchName?: string
                baseBranch?: string
                remoteBranch?: string
                prTitle?: string
                prBody?: string
            },
        ) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify(input),
                },
            ).then((r) => r.branch),

        /** Runs `pi` over the branch's commit history. Slow — minutes, not seconds. */
        describeBranch: (name: string) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}/describe`,
                {
                    method: "POST",
                    body: JSON.stringify({}),
                },
            ).then((r) => r.branch),

        getChecks: (name: string) =>
            request<
                Pick<
                    CombinedBranchDetail,
                    "checks" | "checksRunning" | "checksSupervision"
                >
            >(`/branches/${branchPath(name)}/checks`),

        /** Starts all checks, a single check, or resumes an incomplete suite. */
        runChecks: (
            name: string,
            check?: string,
            resume = false,
            from?: string,
        ) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}/checks`,
                {
                    method: "POST",
                    body: JSON.stringify(
                        from ? { from } : check ? { check } : { resume },
                    ),
                },
            ).then((r) => r.branch),

        /** Runs the suite with a supervisor that fixes each failure and resumes. */
        runChecksWithSupervisor: (
            name: string,
            supervisor: RunSupervisor,
            resume: boolean,
        ) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}/checks`,
                {
                    method: "POST",
                    body: JSON.stringify({ resume, supervisor }),
                },
            ).then((r) => r.branch),

        stopChecksSupervisor: (name: string) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}/checks-supervisor`,
                { method: "DELETE" },
            ).then((r) => r.branch),

        createPr: (name: string, draft: boolean, force = false) =>
            request<{ branch: CombinedBranchDetail; pushed: boolean }>(
                `/branches/${branchPath(name)}/pr`,
                { method: "POST", body: JSON.stringify({ draft, force }) },
            ),

        pushBranch: (name: string, force = false) =>
            request<{ branch: CombinedBranchDetail }>(
                `/branches/${branchPath(name)}/push`,
                { method: "POST", body: JSON.stringify({ force }) },
            ).then((r) => r.branch),

        forgetBranch: (name: string) =>
            request<{ deleted: string }>(`/branches/${branchPath(name)}`, {
                method: "DELETE",
            }),

        /* --------------------------------------------------------------- notes */

        listNotes: (
            query: { tag?: string; folder?: string; q?: string } = {},
        ) => {
            const search = new URLSearchParams(
                Object.entries(query).filter(([, value]) => value) as [
                    string,
                    string,
                ][],
            ).toString()
            return request<NoteListing>(`/notes${search ? `?${search}` : ""}`)
        },

        getNote: (path: string) =>
            request<{ note: Note }>(`/notes/${notePath(path)}`).then(
                (r) => r.note,
            ),

        createNote: (input: {
            title: string
            folder?: string
            path?: string
            body?: string
            tags?: string[]
        }) =>
            request<{ note: Note }>("/notes", {
                method: "POST",
                body: JSON.stringify(input),
            }).then((r) => r.note),

        updateNote: (
            path: string,
            input: {
                title?: string
                body?: string
                tags?: string[]
                path?: string
            },
        ) =>
            request<{ note: Note }>(`/notes/${notePath(path)}`, {
                method: "PATCH",
                body: JSON.stringify(input),
            }).then((r) => r.note),

        deleteNote: (path: string) =>
            request<{ deleted: string }>(`/notes/${notePath(path)}`, {
                method: "DELETE",
            }),

        /** Upload one or more files against a note. Multipart, so no JSON body here —
         *  `request` would otherwise set a content-type that loses the boundary. */
        uploadAttachments: async (path: string, files: File[]) => {
            const form = new FormData()
            for (const file of files) form.append("file", file, file.name)

            const response = await fetchImpl(
                `${baseUrl}/api/notes/${notePath(path)}/attachments`,
                {
                    method: "POST",
                    body: form,
                },
            )
            const payload = (await response.json().catch(() => null)) as {
                added: { attachment: NoteAttachment; markdown: string }[]
                note: Note
                error?: string
            } | null
            if (!response.ok || !payload)
                throw new Error(
                    payload?.error ?? `Upload failed (${response.status}).`,
                )
            return payload
        },

        deleteAttachment: (path: string, name: string) =>
            request<{ note: Note }>(
                `/notes/${notePath(path)}/attachments/${encodeURIComponent(name)}`,
                {
                    method: "DELETE",
                },
            ).then((r) => r.note),

        initNotes: () =>
            request<{ workspace: NotesWorkspaceInfo }>("/notes/init", {
                method: "POST",
                body: JSON.stringify({}),
            }).then((r) => r.workspace),

        /* -------------------------------------------------------------- issues */

        listIssues: (
            query: {
                state?: IssueState | "all"
                source?: string
                label?: string
                q?: string
            } = {},
        ) => {
            const search = new URLSearchParams(
                Object.entries(query).filter(([, value]) => value) as [
                    string,
                    string,
                ][],
            ).toString()
            return request<IssueListing>(`/issues${search ? `?${search}` : ""}`)
        },

        getIssue: (id: string) =>
            request<{ issue: IssueDetail }>(
                `/issues/${encodeURIComponent(id)}`,
            ).then((r) => r.issue),

        /* -------------------------------------------------------------- agents */

        /** Which harnesses are installed, and whether a terminal window can be opened. */
        agentEnvironment: () => request<AgentEnvironment>("/agents"),

        configFile: () => request<{ content: string }>("/config"),
        saveConfigFile: (content: string) =>
            request<{ content: string }>("/config", {
                method: "PUT",
                body: JSON.stringify({ content }),
            }),

        /** Fetched when a harness is chosen — pi's catalogue is large and slow. */
        agentModels: (harness: string) =>
            request<{ models: AgentModel[] }>(
                `/agents/models?harness=${encodeURIComponent(harness)}`,
            ).then((r) => r.models),

        /** Start an agent. The server builds the command line; this sends the intent. */
        startAgentRun: (input: {
            harness: string
            model: string
            mode: AgentRunMode
            command: AgentCommand
            target: string
            extra: string
            subjectKind: string
            subjectRef: string
            permissionMode: AgentPermissionMode
            /** A configured machine id. Omit for this computer. */
            machine?: string | null
            /** Required by `resolve-conflicts`: what collided, and where. */
            conflict?: GitConflict
        }) =>
            request<{ run: AgentRun }>("/agents/run", {
                method: "POST",
                body: JSON.stringify(input),
            }).then((r) => r.run),

        listAgentRuns: (subject?: { kind: string; ref: string }) => {
            const search = subject
                ? `?kind=${encodeURIComponent(subject.kind)}&ref=${encodeURIComponent(subject.ref)}`
                : ""
            return request<{ runs: AgentRun[] }>(`/agents/runs${search}`).then(
                (r) => r.runs,
            )
        },

        /** The run plus the tail of its log — polled while a headless run is going. */
        getAgentRun: (id: number) =>
            request<{ run: AgentRunDetail }>(`/agents/runs/${id}`).then(
                (r) => r.run,
            ),

        stopAgentRun: (id: number) =>
            request<{ run: AgentRun }>(`/agents/runs/${id}/stop`, {
                method: "POST",
            }).then((r) => r.run),

        /** Reopen a run's conversation in a new terminal window. The run itself is
         *  untouched — this is the same session, opened again, not a new run. */
        resumeAgentRun: (id: number) =>
            request<{ run: AgentRun }>(`/agents/runs/${id}/resume`, {
                method: "POST",
            }).then((r) => r.run),

        /* ---------------------------------------------------------- work package runs */

        /**
         * Work a whole work package unattended: a fresh headless agent per task, the server
         * driving the queue between them.
         *
         * The settings are chosen once and used for every task in the loop. There is
         * no run mode to pick — an interactive run cannot be waited on, and one that
         * can ask questions holds the queue until somebody answers.
         */
        startWorkPackageRun: (
            ref: string,
            input: {
                harness: string
                model: string
                permissionMode: AgentPermissionMode
                extra: string
                excluded: string[]
            },
        ) =>
            request<{
                workPackageRun: WorkPackageRun
                run: AgentRun
                workPackage: WorkPackageDetail
            }>(`/work-packages/${encodeURIComponent(ref)}/run`, {
                method: "POST",
                body: JSON.stringify(input),
            }),

        /** Kill the agent in flight and stop the loop. What already merged stays. */
        stopWorkPackageRun: (ref: string) =>
            request<{
                workPackageRun: WorkPackageRun
                workPackage: WorkPackageDetail
            }>(`/work-packages/${encodeURIComponent(ref)}/run`, {
                method: "DELETE",
            }),

        listWorkPackageRuns: (ref: string) =>
            request<{ runs: WorkPackageRun[] }>(
                `/work-packages/${encodeURIComponent(ref)}/runs`,
            ).then((r) => r.runs),

        syncNotes: (push: boolean) =>
            request<{
                committed: string | null
                pushed: boolean
                git: NotesGitInfo
            }>("/notes/sync", {
                method: "POST",
                body: JSON.stringify({ push }),
            }),

        /** Fetch and fast-forward the notes repository — the source of both the Notes
         *  view and Issues, so both offer it. */
        pullNotes: () =>
            request<{
                received: number
                upstream: string | null
                unpushed: number
                merged: boolean
                /** Set when a merge was needed and collided. Already aborted. */
                conflict: GitConflict | null
                git: NotesGitInfo
                workspace: NotesWorkspaceInfo
            }>("/notes/pull", { method: "POST" }),
    }

    /** Branch names contain slashes, so they travel as a single encoded segment. */
    function branchPath(name: string): string {
        return encodeURIComponent(name)
    }

    /** Note paths contain slashes, so they travel as one encoded segment too. */
    function notePath(path: string): string {
        return encodeURIComponent(path)
    }

    /**
     * URL for a file inside the notes folder.
     *
     * A note's links are relative to the note itself, so the raw `href` is sent
     * along with the note's path and the *server* resolves the pair — the browser
     * has no business deciding which files inside that folder it may read.
     */
    function noteAssetUrl(notePath_: string, hrefInNote: string): string {
        return `${baseUrl}/api/notes/asset?note=${encodeURIComponent(notePath_)}&href=${encodeURIComponent(hrefInNote)}`
    }

    /** URL for a screenshot the server streams out of the aio-vr workspace. */
    function imageUrl(path: string | null): string | null {
        return path
            ? `${baseUrl}/api/image?path=${encodeURIComponent(path)}`
            : null
    }

    /** URL for a file attached to a task. */
    function taskAssetUrl(ref: string, name: string): string {
        return `${baseUrl}/api/tasks/asset?ref=${encodeURIComponent(ref)}&name=${encodeURIComponent(name)}`
    }

    return {
        ...api,
        /** Where this client sends requests; empty means the page's origin. */
        baseUrl,
        noteAssetUrl,
        imageUrl,
        taskAssetUrl,
        /** `GET /api`: confirms the server and the contract version it speaks. */
        info: () =>
            request<{ name: string; apiVersion: number; repoRoot: string }>(""),
        /**
         * Listen for writes to the workspace, from this UI, the CLI or an agent.
         * Calls `onChange` with the channel that moved; re-fetch whatever you
         * show from that channel. Returns a function that stops listening.
         */
        subscribe: (
            onChange: (event: ChangeEvent) => void,
            onOpen?: (revisions: Record<ChangeChannel, number>) => void,
        ) => subscribeToChanges(baseUrl, onChange, onOpen),
    }
}

export type TasksClient = ReturnType<typeof createClient>
