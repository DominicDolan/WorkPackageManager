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

export const INVESTIGATION_STATUSES = ['draft', 'investigating', 'complete'] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const INVESTIGATION_STATUS_LABELS: Record<InvestigationStatus, string> = {
  draft: 'Draft',
  investigating: 'Investigating',
  complete: 'Complete',
};

export interface Task {
  id: number;
  ref: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  /** Where the task sits in the manually ordered list — lower is nearer the top.
   *  The top of the list is what `/work-task` picks up when given no ref, so this
   *  is the work queue, not a cosmetic preference. Dense but not guaranteed
   *  contiguous: a reorder only permutes the positions it was handed. */
  position: number;
  tags: string[];
  /** The investigation that filed this task, when one did. Plain ref, not a
   *  foreign key — a task outlives the investigation that produced it. */
  investigationRef: string | null;
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

/* ------------------------------------------------------------ investigations */

/**
 * A question written down before anyone goes looking. The human writes `brief`;
 * an agent runs it via `/plan-tasks`, writes `findings` back, and files the work
 * it turned up as tasks pointing at this ref.
 */
export interface Investigation {
  id: number;
  ref: string;
  title: string;
  /** What to investigate — the human's input, free-form Markdown. */
  brief: string;
  /** What the agent concluded. Empty until an investigation has been run. */
  findings: string;
  status: InvestigationStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** An investigation plus the tasks it produced. */
export interface InvestigationDetail extends Investigation {
  tasks: Task[];
}

/* -------------------------------------------------------------- notes */

/**
 * A note, as it exists on disk: one Markdown file inside the notes folder.
 *
 * Notes are deliberately *not* in the database. The folder is meant to be a Git
 * repository of its own that a human can clone, grep, edit in another editor and
 * push somewhere — so the file is the record, and everything here is read back
 * out of it rather than mirrored alongside it.
 */
export interface NoteSummary {
  /** Path relative to the notes root, always ending `.md` — e.g. `ideas/gantt.md`.
   *  This is the note's identity: there is no id, because renaming the file in
   *  another editor must not orphan anything. */
  path: string;
  /** Frontmatter `title`, falling back to the filename. */
  title: string;
  tags: string[];
  /** Directory the note sits in, `''` at the root. */
  folder: string;
  /** First couple of lines of prose, for the list column. */
  excerpt: string;
  createdAt: string;
  updatedAt: string;
}

/** A file stored alongside a note — an image, a PDF, a dropped screenshot. */
export interface NoteAttachment {
  name: string;
  /** Path relative to the notes root, as the server serves it. */
  path: string;
  /** Path as it is written in the Markdown, relative to the note itself. */
  href: string;
  size: number;
  isImage: boolean;
}

/** A note plus its body and attachments — what the detail view edits. */
export interface Note extends NoteSummary {
  /** The Markdown below the frontmatter. */
  body: string;
  attachments: NoteAttachment[];
}

/** Live Git state of the notes folder. Read fresh per request: it is an ordinary
 *  repository somebody may commit to, pull or push from outside this app. */
export interface NotesGitInfo {
  /** False when the folder exists but was never `git init`ed. */
  repo: boolean;
  branch: string | null;
  /** Paths with uncommitted changes. */
  dirty: number;
  lastCommit: { shortSha: string; subject: string; date: string } | null;
  upstream: string | null;
  /** Commits not yet pushed. Null when there is no upstream to compare with. */
  unpushed: number | null;
}

/** Where the notes live and what state that folder is in. */
export interface NotesWorkspaceInfo {
  /** Absolute path to the notes folder. */
  dir: string;
  exists: boolean;
  /** Whether a write commits automatically (`notesAutoCommit`). */
  autoCommit: boolean;
  git: NotesGitInfo;
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
  /** A combine stopped on a Git conflict and needs `git cherry-pick --continue`. */
  combineState: 'complete' | 'conflict';
  /** Commits still to cherry-pick after a conflict is resolved. */
  combinePendingCommits: string[];
  /** Whether tasks should be closed when this combine finishes. */
  combineCloseTasks: boolean;
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
