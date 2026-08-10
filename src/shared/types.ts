/** Types shared by the CLI, the bun server and the Vue app. */

export const STATUSES = ['backlog', 'in_progress', 'dev_complete', 'verified', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  dev_complete: 'Dev Complete',
  verified: 'Verified',
  closed: 'Closed',
};

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Which checkpoint phase a capture belongs to. */
export type Phase = 'before' | 'after';

/** Per-scenario outcome, mirroring aio-vr's own vocabulary. */
export type ComparisonStatus = 'unchanged' | 'changed' | 'failed' | 'new-baseline';

export interface Task {
  id: number;
  ref: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  tags: string[];
  /** The Git branch assigned when the task is created. Legacy completed tasks may not have one. */
  branchName: string | null;
  checkpointName: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  devCompletedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  type: 'created' | 'status' | 'edited' | 'note' | 'checkpoint';
  fromStatus: Status | null;
  toStatus: Status | null;
  note: string | null;
  createdAt: string;
}

export interface Comparison {
  id: number;
  runId: number;
  scenario: string;
  description: string | null;
  status: ComparisonStatus;
  percentChanged: number | null;
  pixelDiffCount: number | null;
  totalPixels: number | null;
  /** Repo-root-relative paths; the server streams them through /api/image. */
  beforePath: string | null;
  afterPath: string | null;
  diffPath: string | null;
  browserLogStatus: string | null;
  browserLogChangeCount: number | null;
}

export interface CheckpointRun {
  id: number;
  taskId: number;
  checkpointName: string;
  phase: Phase;
  exitCode: number;
  gitHead: string | null;
  gitDirty: number | null;
  scenarioCount: number;
  /** The --scenario / --folder filters this run used, if any. */
  selection: { scenarios?: string[]; folders?: string[] } | null;
  createdAt: string;
  comparisons: Comparison[];
}

/** A task plus everything the detail view needs. */
export interface TaskDetail extends Task {
  events: TaskEvent[];
  runs: CheckpointRun[];
}

/* ------------------------------------------------------ combined branches */

/** One delivery branch built by combining several task branches. Recorded when
 *  the combine succeeds, so the branch outlives the tasks being closed. */
export interface CombinedBranch {
  id: number;
  branchName: string;
  /** The branch the combine was cut from — the PR's base by default. */
  baseBranch: string | null;
  /** Refs of the tasks cherry-picked in, in combine order. */
  taskRefs: string[];
  prTitle: string | null;
  prBody: string | null;
  prUrl: string | null;
  prNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BranchCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

/** Live Git state for a branch. Read fresh on every request — a branch can be
 *  deleted, pushed or advanced from outside this app at any time. */
export interface BranchGitInfo {
  exists: boolean;
  /** Set when the branch has a configured upstream, e.g. `origin/feature/x`. */
  upstream: string | null;
  /** Commits unique to this branch relative to its base, oldest first. */
  commits: BranchCommit[];
  filesChanged: number;
  /** Null when the base branch cannot be resolved (deleted, renamed). */
  aheadOfBase: number | null;
}

/** A combined branch plus its live Git state and the tasks it carries. */
export interface CombinedBranchDetail extends CombinedBranch {
  git: BranchGitInfo;
  tasks: Task[];
}

/** Which external CLIs the Branches view can use, and what they are called. */
export interface ToolAvailability {
  /** The configured PR-description agent, or null when the feature is off. */
  prAgent: string | null;
  prAgentAvailable: boolean;
  gh: boolean;
  ghAuthed: boolean;
}

/** Whether a task's before/after screenshots are ready to look at. */
export function hasVisualEvidence(task: Pick<Task, 'status'>, runs: CheckpointRun[]): boolean {
  return runs.some((run) => run.phase === 'after' && run.comparisons.length > 0);
}

/** Checkpoint name derived from a task ref. Kept in one place so the CLI, the
 *  server and the UI never disagree about which checkpoint belongs to a task. */
export function checkpointNameFor(ref: string, prefix = 'task-'): string {
  return `${prefix}${ref.toLowerCase()}`;
}

/** A deterministic, Git-friendly default branch for a task. */
export function branchNameFor(ref: string, title: string, prefix = 'feature/'): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
  return `${prefix}${ref.toLowerCase()}-${slug}`;
}
