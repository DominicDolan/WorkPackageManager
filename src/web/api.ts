import type {
  AgentCommand,
  AgentEnvironment,
  AgentModel,
  AgentRun,
  AgentRunDetail,
  AgentRunMode,
  CombinedBranchDetail,
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
  Priority,
  Status,
  Task,
  TaskDetail,
  ToolAvailability,
} from '@shared/types';

export interface Meta {
  statuses: Status[];
  priorities: Priority[];
  repoRoot: string;
  aioVrDir: string;
  aioVrInstalled: boolean;
  aioVrWorkspaceExists: boolean;
  /** Where the notes live and what state that folder is in. */
  notes: NotesWorkspaceInfo;
  /** Which external CLIs the Branches view can use. */
  tools: ToolAvailability;
}

/** The Issues view's payload: the cards, plus what the filters can offer. */
export interface IssueListing {
  issues: IssueSummary[];
  facets: { sources: { source: string; count: number }[]; labels: string[]; total: number };
  notes: NotesWorkspaceInfo;
}

/** The Notes sidebar's whole payload: one read gives the list and its filters. */
export interface NoteListing {
  notes: NoteSummary[];
  folders: string[];
  tags: string[];
  workspace: NotesWorkspaceInfo;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;

  if (!response.ok) {
    // The page is served off disk but the API is whatever process is running,
    // so a rebuilt UI can be talking to a server started before the endpoint
    // existed. That reads as an unexplained 404/405 on a brand-new route.
    // Matched on the routing errors specifically: a 404 also means "no task
    // with that ref", which is a real answer and must keep its own message.
    const unrouted = payload?.error === 'Unknown endpoint.' || payload?.error === 'Method not allowed.';
    if (unrouted) {
      throw new Error(
        `The running \`tasks web\` server does not have ${path} — it was started ` +
          'before this version of the UI. Restart it and reload.',
      );
    }
    throw new Error(payload?.error ?? `Request failed (${response.status}).`);
  }
  return payload as T;
}

export const api = {
  meta: () => request<Meta>('/meta'),

  listTasks: (status?: Status) =>
    request<{ tasks: Task[] }>(`/tasks${status ? `?status=${status}` : ''}`).then((r) => r.tasks),

  getTask: (ref: string) => request<{ task: TaskDetail }>(`/tasks/${ref}`).then((r) => r.task),

  createTask: (input: { title: string; description?: string; priority?: Priority; tags?: string[]; branchName?: string; investigationRef?: string }) =>
    request<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.task,
    ),

  updateTask: (
    ref: string,
    input: { title?: string; description?: string; priority?: Priority; tags?: string[]; branchName?: string },
  ) =>
    request<{ task: TaskDetail }>(`/tasks/${ref}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.task),

  deleteTask: (ref: string) => request<{ deleted: string }>(`/tasks/${ref}`, { method: 'DELETE' }),

  /** Rearrange `refs` into the order given. Only the positions those tasks
   *  already hold are redistributed, so passing a filtered subset is safe.
   *  Returns the full list as the server now orders it. */
  reorderTasks: (refs: string[]) =>
    request<{ tasks: Task[] }>('/tasks/reorder', {
      method: 'POST',
      body: JSON.stringify({ refs }),
    }).then((r) => r.tasks),

  previewCombine: (refs: string[]) =>
    request<{ tasks: { task: TaskDetail; exists: boolean; candidates: string[] }[] }>('/tasks/combine/preview', {
      method: 'POST', body: JSON.stringify({ refs }),
    }),

  combineTasks: (refs: string[], branchName: string, closeTasks: boolean) =>
    request<{ branchName: string; tasks: TaskDetail[]; conflicted: boolean }>('/tasks/combine', {
      method: 'POST',
      body: JSON.stringify({ refs, branchName, closeTasks }),
    }),
  continueCombine: (branchName: string) =>
    request<{ branchName: string; tasks: TaskDetail[] }>('/tasks/combine/continue', {
      method: 'POST', body: JSON.stringify({ branchName }),
    }),

  closeTask: (ref: string) =>
    request<{ task: TaskDetail }>(`/tasks/${ref}/close`, { method: 'POST' }).then((r) => r.task),

  setStatus: (ref: string, status: Status, note?: string) =>
    request<{ task: TaskDetail }>(`/tasks/${ref}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, note }),
    }).then((r) => r.task),

  addNote: (ref: string, note: string) =>
    request<{ task: TaskDetail }>(`/tasks/${ref}/notes`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }).then((r) => r.task),

  capture: (ref: string, phase: 'before' | 'after') =>
    request<{ task: TaskDetail }>(`/tasks/${ref}/checkpoint/${phase}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((r) => r.task),

  /* ------------------------------------------------------ investigations */

  listInvestigations: () =>
    request<{ investigations: Investigation[] }>('/investigations').then((r) => r.investigations),

  getInvestigation: (ref: string) =>
    request<{ investigation: InvestigationDetail }>(`/investigations/${ref}`).then(
      (r) => r.investigation,
    ),

  createInvestigation: (input: { title: string; brief?: string }) =>
    request<{ investigation: InvestigationDetail }>('/investigations', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.investigation),

  updateInvestigation: (ref: string, input: { title?: string; brief?: string; findings?: string }) =>
    request<{ investigation: InvestigationDetail }>(`/investigations/${ref}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.investigation),

  setInvestigationStatus: (ref: string, status: InvestigationStatus) =>
    request<{ investigation: InvestigationDetail }>(`/investigations/${ref}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }).then((r) => r.investigation),

  deleteInvestigation: (ref: string) =>
    request<{ deleted: string }>(`/investigations/${ref}`, { method: 'DELETE' }),

  /* ------------------------------------------------------------ branches */

  listBranches: () =>
    request<{ branches: CombinedBranchDetail[]; defaultBase: string }>('/branches'),

  getBranch: (name: string) =>
    request<{ branch: CombinedBranchDetail }>(`/branches/${branchPath(name)}`).then((r) => r.branch),

  updateBranch: (name: string, input: { branchName?: string; baseBranch?: string; prTitle?: string; prBody?: string }) =>
    request<{ branch: CombinedBranchDetail }>(`/branches/${branchPath(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.branch),

  /** Runs `pi` over the branch's commit history. Slow — minutes, not seconds. */
  describeBranch: (name: string) =>
    request<{ branch: CombinedBranchDetail }>(`/branches/${branchPath(name)}/describe`, {
      method: 'POST',
      body: JSON.stringify({}),
    }).then((r) => r.branch),

  createPr: (name: string, draft: boolean) =>
    request<{ branch: CombinedBranchDetail; pushed: boolean }>(
      `/branches/${branchPath(name)}/pr`,
      { method: 'POST', body: JSON.stringify({ draft }) },
    ),

  forgetBranch: (name: string) =>
    request<{ deleted: string }>(`/branches/${branchPath(name)}`, { method: 'DELETE' }),

  /* --------------------------------------------------------------- notes */

  listNotes: (query: { tag?: string; folder?: string; q?: string } = {}) => {
    const search = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value) as [string, string][],
    ).toString();
    return request<NoteListing>(`/notes${search ? `?${search}` : ''}`);
  },

  getNote: (path: string) => request<{ note: Note }>(`/notes/${notePath(path)}`).then((r) => r.note),

  createNote: (input: { title: string; folder?: string; path?: string; body?: string; tags?: string[] }) =>
    request<{ note: Note }>('/notes', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.note),

  updateNote: (path: string, input: { title?: string; body?: string; tags?: string[]; path?: string }) =>
    request<{ note: Note }>(`/notes/${notePath(path)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.note),

  deleteNote: (path: string) => request<{ deleted: string }>(`/notes/${notePath(path)}`, { method: 'DELETE' }),

  /** Upload one or more files against a note. Multipart, so no JSON body here —
   *  `request` would otherwise set a content-type that loses the boundary. */
  uploadAttachments: async (path: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('file', file, file.name);

    const response = await fetch(`/api/notes/${notePath(path)}/attachments`, { method: 'POST', body: form });
    const payload = (await response.json().catch(() => null)) as
      | { added: { attachment: NoteAttachment; markdown: string }[]; note: Note; error?: string }
      | null;
    if (!response.ok || !payload) throw new Error(payload?.error ?? `Upload failed (${response.status}).`);
    return payload;
  },

  deleteAttachment: (path: string, name: string) =>
    request<{ note: Note }>(`/notes/${notePath(path)}/attachments/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }).then((r) => r.note),

  initNotes: () =>
    request<{ workspace: NotesWorkspaceInfo }>('/notes/init', { method: 'POST', body: JSON.stringify({}) }).then(
      (r) => r.workspace,
    ),

  /* -------------------------------------------------------------- issues */

  listIssues: (query: { state?: IssueState | 'all'; source?: string; label?: string; q?: string } = {}) => {
    const search = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value) as [string, string][],
    ).toString();
    return request<IssueListing>(`/issues${search ? `?${search}` : ''}`);
  },

  getIssue: (id: string) =>
    request<{ issue: IssueDetail }>(`/issues/${encodeURIComponent(id)}`).then((r) => r.issue),

  /* -------------------------------------------------------------- agents */

  /** Which harnesses are installed, and whether a terminal window can be opened. */
  agentEnvironment: () => request<AgentEnvironment>('/agents'),

  /** Fetched only when a harness is chosen — pi's catalogue is large and slow. */
  agentModels: (harness: string) =>
    request<{ models: AgentModel[] }>(`/agents/models?harness=${encodeURIComponent(harness)}`).then(
      (r) => r.models,
    ),

  /** Start an agent. The server builds the command line; this sends the intent. */
  startAgentRun: (input: {
    harness: string;
    model: string;
    mode: AgentRunMode;
    command: AgentCommand;
    target: string;
    extra: string;
    subjectKind: string;
    subjectRef: string;
    unattended: boolean;
  }) =>
    request<{ run: AgentRun }>('/agents/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.run),

  listAgentRuns: (subject?: { kind: string; ref: string }) => {
    const search = subject
      ? `?kind=${encodeURIComponent(subject.kind)}&ref=${encodeURIComponent(subject.ref)}`
      : '';
    return request<{ runs: AgentRun[] }>(`/agents/runs${search}`).then((r) => r.runs);
  },

  /** The run plus the tail of its log — polled while a headless run is going. */
  getAgentRun: (id: number) =>
    request<{ run: AgentRunDetail }>(`/agents/runs/${id}`).then((r) => r.run),

  stopAgentRun: (id: number) =>
    request<{ run: AgentRun }>(`/agents/runs/${id}/stop`, { method: 'POST' }).then((r) => r.run),

  syncNotes: (push: boolean) =>
    request<{ committed: string | null; pushed: boolean; git: NotesGitInfo }>('/notes/sync', {
      method: 'POST',
      body: JSON.stringify({ push }),
    }),
};

/** Branch names contain slashes, so they travel as a single encoded segment. */
function branchPath(name: string): string {
  return encodeURIComponent(name);
}

/** Note paths contain slashes, so they travel as one encoded segment too. */
function notePath(path: string): string {
  return encodeURIComponent(path);
}

/**
 * URL for a file inside the notes folder.
 *
 * A note's links are relative to the note itself, so the raw `href` is sent
 * along with the note's path and the *server* resolves the pair — the browser
 * has no business deciding which files inside that folder it may read.
 */
export function noteAssetUrl(notePath_: string, hrefInNote: string): string {
  return `/api/notes/asset?note=${encodeURIComponent(notePath_)}&href=${encodeURIComponent(hrefInNote)}`;
}

/** URL for a screenshot the server streams out of the aio-vr workspace. */
export function imageUrl(path: string | null): string | null {
  return path ? `/api/image?path=${encodeURIComponent(path)}` : null;
}
