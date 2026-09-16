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
  IssueSummary,
  Note,
  NoteAttachment,
  NoteSummary,
  NotesGitInfo,
  NotesWorkspaceInfo,
  ModelTier,
  Priority,
  Status,
  Task,
  TaskAttachment,
  TaskDetail,
  WorkPackage,
  BaselineReport,
  WorkPackageDetail,
  WorkPackageSummary,
  ToolAvailability,
} from "@shared/types"

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
  issues: IssueSummary[]
  facets: {
    sources: { source: string; count: number }[]
    labels: string[]
    total: number
  }
  notes: NotesWorkspaceInfo
}

/** The Notes sidebar's whole payload: one read gives the list and its filters. */
export interface NoteListing {
  notes: NoteSummary[]
  folders: string[]
  tags: string[]
  workspace: NotesWorkspaceInfo
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
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
    throw new Error(payload?.error ?? `Request failed (${response.status}).`)
  }
  return payload as T
}

export const api = {
  meta: () => request<Meta>("/meta"),

  listTasks: (status?: Status) =>
    request<{ tasks: Task[] }>(
      `/tasks${status ? `?status=${status}` : ""}`,
    ).then((r) => r.tasks),

  /* ----------------------------------------------------------- baselines */

  /** The last `aio-vr run`, joined with what has been approved since. */
  baselines: () =>
    request<{ report: BaselineReport }>("/baselines").then((r) => r.report),

  /** Re-drive the browser. No scenarios means the whole suite, which is slow —
   *  minutes, not seconds. A non-zero `exitCode` means something drifted, which
   *  is a result rather than a failure. */
  runBaselines: (scenarios: string[] = []) =>
    request<{ report: BaselineReport; exitCode: number; output: string }>(
      "/baselines/run",
      {
        method: "POST",
        body: JSON.stringify({ scenarios }),
      },
    ),

  /** Promote one scenario's latest capture to be its baseline. */
  approveBaseline: (scenario: string) =>
    request<{ report: BaselineReport }>("/baselines/approve", {
      method: "POST",
      body: JSON.stringify({ scenario }),
    }).then((r) => r.report),

  /* -------------------------------------------------------------- work packages */

  listWorkPackages: () =>
    request<{ workPackages: WorkPackageSummary[] }>("/work-packages").then(
      (r) => r.workPackages,
    ),

  /** One work package, its tasks, the order they can be worked in, and the live state
   *  of the branch they all sit on. */
  getWorkPackage: (ref: string) =>
    request<{ workPackage: WorkPackageDetail }>(
      `/work-packages/${encodeURIComponent(ref)}`,
    ).then((r) => r.workPackage),

  createWorkPackage: (input: {
    name: string
    description?: string
    investigation?: string
    color?: string
    branchName?: string
    investigationRef?: string
  }) =>
    request<{ workPackage: WorkPackage; workPackages: WorkPackageSummary[] }>(
      "/work-packages",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),

  /** Give a legacy work package its investigation record without moving or replacing it. */
  ensureWorkPackageInvestigation: (ref: string, brief?: string) =>
    request<{
      investigation: Investigation
      workPackage: WorkPackageDetail
      workPackages: WorkPackageSummary[]
    }>(`/work-packages/${encodeURIComponent(ref)}/investigation`, {
      method: "POST",
      body: JSON.stringify({ brief }),
    }),

  updateWorkPackage: (
    ref: string,
    input: {
      name?: string
      description?: string
      color?: string
      branchName?: string
    },
  ) =>
    request<{ workPackages: WorkPackageSummary[]; tasks: Task[] }>(
      `/work-packages/${encodeURIComponent(ref)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),

  attachWorkPackageNote: (ref: string, path: string) =>
    request<{ workPackage: WorkPackageDetail }>(
      `/work-packages/${encodeURIComponent(ref)}/note-links`,
      { method: "POST", body: JSON.stringify({ path }) },
    ).then((r) => r.workPackage),

  detachWorkPackageNote: (ref: string, path: string) =>
    request<{ workPackage: WorkPackageDetail }>(
      `/work-packages/${encodeURIComponent(ref)}/note-links/${notePath(path)}`,
      { method: "DELETE" },
    ).then((r) => r.workPackage),

  /** Deletes the organizing, never the tasks — the response says which ones were
   *  turned loose so the UI can say so too. */
  deleteWorkPackage: (ref: string) =>
    request<{
      deleted: string
      released: string[]
      workPackages: WorkPackageSummary[]
      tasks: Task[]
    }>(`/work-packages/${encodeURIComponent(ref)}`, { method: "DELETE" }),

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
    request<{ workPackages: WorkPackageSummary[] }>("/work-packages/reorder", {
      method: "POST",
      body: JSON.stringify({ refs }),
    }).then((r) => r.workPackages),

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

  combineTasks: (refs: string[], branchName: string, closeTasks: boolean) =>
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

  attachTaskNote: (ref: string, path: string) =>
    request<{ task: TaskDetail }>(
      `/tasks/${encodeURIComponent(ref)}/note-links`,
      { method: "POST", body: JSON.stringify({ path }) },
    ).then((r) => r.task),

  detachTaskNote: (ref: string, path: string) =>
    request<{ task: TaskDetail }>(
      `/tasks/${encodeURIComponent(ref)}/note-links/${notePath(path)}`,
      { method: "DELETE" },
    ).then((r) => r.task),

  /** Upload one or more files against a task. Multipart, so no JSON body here —
   *  `request` would otherwise set a content-type that loses the boundary. */
  uploadTaskAttachments: async (ref: string, files: File[]) => {
    const form = new FormData()
    for (const file of files) form.append("file", file, file.name)

    const response = await fetch(`/api/tasks/${ref}/attachments`, {
      method: "POST",
      body: form,
    })
    const payload = (await response.json().catch(() => null)) as {
      added: TaskAttachment[]
      task: TaskDetail
      error?: string
    } | null
    if (!response.ok || !payload)
      throw new Error(payload?.error ?? `Upload failed (${response.status}).`)
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

  /* ------------------------------------------------------ investigations */

  listInvestigations: () =>
    request<{ investigations: Investigation[] }>("/investigations").then(
      (r) => r.investigations,
    ),

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
    request<{ investigation: InvestigationDetail }>(`/investigations/${ref}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then((r) => r.investigation),

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
    request<{ branch: CombinedBranchDetail }>(`/branches/${branchPath(name)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then((r) => r.branch),

  /** Runs `pi` over the branch's commit history. Slow — minutes, not seconds. */
  describeBranch: (name: string) =>
    request<{ branch: CombinedBranchDetail }>(
      `/branches/${branchPath(name)}/describe`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ).then((r) => r.branch),

  /** Starts all configured checks, or one named check, in the background. */
  runChecks: (name: string, check?: string) =>
    request<{ branch: CombinedBranchDetail }>(
      `/branches/${branchPath(name)}/checks`,
      {
        method: "POST",
        body: JSON.stringify(check ? { check } : {}),
      },
    ).then((r) => r.branch),

  createPr: (name: string, draft: boolean, force = false) =>
    request<{ branch: CombinedBranchDetail; pushed: boolean }>(
      `/branches/${branchPath(name)}/pr`,
      { method: "POST", body: JSON.stringify({ draft, force }) },
    ),

  forgetBranch: (name: string) =>
    request<{ deleted: string }>(`/branches/${branchPath(name)}`, {
      method: "DELETE",
    }),

  /* --------------------------------------------------------------- notes */

  listNotes: (query: { tag?: string; folder?: string; q?: string } = {}) => {
    const search = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value) as [string, string][],
    ).toString()
    return request<NoteListing>(`/notes${search ? `?${search}` : ""}`)
  },

  getNote: (path: string) =>
    request<{ note: Note }>(`/notes/${notePath(path)}`).then((r) => r.note),

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
    input: { title?: string; body?: string; tags?: string[]; path?: string },
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

    const response = await fetch(`/api/notes/${notePath(path)}/attachments`, {
      method: "POST",
      body: form,
    })
    const payload = (await response.json().catch(() => null)) as {
      added: { attachment: NoteAttachment; markdown: string }[]
      note: Note
      error?: string
    } | null
    if (!response.ok || !payload)
      throw new Error(payload?.error ?? `Upload failed (${response.status}).`)
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
      Object.entries(query).filter(([, value]) => value) as [string, string][],
    ).toString()
    return request<IssueListing>(`/issues${search ? `?${search}` : ""}`)
  },

  getIssue: (id: string) =>
    request<{ issue: IssueDetail }>(`/issues/${encodeURIComponent(id)}`).then(
      (r) => r.issue,
    ),

  /* -------------------------------------------------------------- agents */

  /** Which harnesses are installed, and whether a terminal window can be opened. */
  agentEnvironment: () => request<AgentEnvironment>("/agents"),

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
    request<{ run: AgentRunDetail }>(`/agents/runs/${id}`).then((r) => r.run),

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
    request<{ workPackageRun: WorkPackageRun; workPackage: WorkPackageDetail }>(
      `/work-packages/${encodeURIComponent(ref)}/run`,
      {
        method: "DELETE",
      },
    ),

  listWorkPackageRuns: (ref: string) =>
    request<{ runs: WorkPackageRun[] }>(
      `/work-packages/${encodeURIComponent(ref)}/runs`,
    ).then((r) => r.runs),

  syncNotes: (push: boolean) =>
    request<{ committed: string | null; pushed: boolean; git: NotesGitInfo }>(
      "/notes/sync",
      {
        method: "POST",
        body: JSON.stringify({ push }),
      },
    ),

  /** Fetch and fast-forward the notes repository — the source of both the Notes
   *  view and Issues, so both offer it. */
  pullNotes: () =>
    request<{
      received: number
      upstream: string | null
      unpushed: number
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
export function noteAssetUrl(notePath_: string, hrefInNote: string): string {
  return `/api/notes/asset?note=${encodeURIComponent(notePath_)}&href=${encodeURIComponent(hrefInNote)}`
}

/** URL for a screenshot the server streams out of the aio-vr workspace. */
export function imageUrl(path: string | null): string | null {
  return path ? `/api/image?path=${encodeURIComponent(path)}` : null
}

/** URL for a file attached to a task. */
export function taskAssetUrl(ref: string, name: string): string {
  return `/api/tasks/asset?ref=${encodeURIComponent(ref)}&name=${encodeURIComponent(name)}`
}
