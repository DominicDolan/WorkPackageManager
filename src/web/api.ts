import type {
  CombinedBranchDetail,
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
  /** Which external CLIs the Branches view can use. */
  tools: ToolAvailability;
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
    throw new Error(payload?.error ?? `Request failed (${response.status}).`);
  }
  return payload as T;
}

export const api = {
  meta: () => request<Meta>('/meta'),

  listTasks: (status?: Status) =>
    request<{ tasks: Task[] }>(`/tasks${status ? `?status=${status}` : ''}`).then((r) => r.tasks),

  getTask: (ref: string) => request<{ task: TaskDetail }>(`/tasks/${ref}`).then((r) => r.task),

  createTask: (input: { title: string; description?: string; priority?: Priority; tags?: string[]; branchName?: string }) =>
    request<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.task,
    ),

  updateTask: (
    ref: string,
    input: { title?: string; description?: string; priority?: Priority; tags?: string[] },
  ) =>
    request<{ task: TaskDetail }>(`/tasks/${ref}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.task),

  deleteTask: (ref: string) => request<{ deleted: string }>(`/tasks/${ref}`, { method: 'DELETE' }),

  combineTasks: (refs: string[], branchName: string, closeTasks: boolean) =>
    request<{ branchName: string; tasks: TaskDetail[] }>('/tasks/combine', {
      method: 'POST',
      body: JSON.stringify({ refs, branchName, closeTasks }),
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

  /* ------------------------------------------------------------ branches */

  listBranches: () =>
    request<{ branches: CombinedBranchDetail[]; defaultBase: string }>('/branches'),

  getBranch: (name: string) =>
    request<{ branch: CombinedBranchDetail }>(`/branches/${branchPath(name)}`).then((r) => r.branch),

  updateBranch: (name: string, input: { baseBranch?: string; prTitle?: string; prBody?: string }) =>
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
};

/** Branch names contain slashes, so they travel as a single encoded segment. */
function branchPath(name: string): string {
  return encodeURIComponent(name);
}

/** URL for a screenshot the server streams out of the aio-vr workspace. */
export function imageUrl(path: string | null): string | null {
  return path ? `/api/image?path=${encodeURIComponent(path)}` : null;
}
