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

/* -------------------------------------------------------------- issues */

/**
 * An issue, read out of a JSON file in the notes folder.
 *
 * Nothing here is provider-specific. GitHub issues and Azure DevOps work items
 * describe the same thing in different words, so the server flattens both into
 * this shape and the UI renders one card for either — `source` decides the badge
 * and nothing else. A provider's own vocabulary survives in `stateLabel`, `kind`
 * and `raw` rather than being bent into fields that only fit one of them.
 */
export type IssueState = 'open' | 'closed';

/** Providers recognised by name. Anything else still renders, badged as itself. */
export const ISSUE_SOURCES = ['github', 'azure-devops'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

export const ISSUE_SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  'azure-devops': 'Azure DevOps',
};

export interface IssueLabel {
  name: string;
  /** `#rrggbb`, when the provider has an opinion. Azure DevOps tags do not. */
  color: string | null;
  description: string | null;
}

export interface IssuePerson {
  name: string;
  avatarUrl: string | null;
  url: string | null;
}

export interface IssueSummary {
  /** Identity: the file's path relative to the notes root, plus `#<index>` when
   *  one file holds several issues. */
  id: string;
  /** The file it came from. */
  path: string;
  /** `github`, `azure-devops`, or whatever the file called itself. */
  source: string;
  /** The provider's own reference, e.g. `#677`. */
  key: string;
  title: string;
  /** Normalised for filtering. */
  state: IssueState;
  /** The provider's own wording — `open`, `Active`, `Resolved`, `not_planned`. */
  stateLabel: string;
  /** Where to open it in a browser. */
  url: string | null;
  /** The repository or project it belongs to. */
  container: string | null;
  /** Bug, Feature, User Story — whatever the provider calls its types. */
  kind: string | null;
  labels: IssueLabel[];
  author: IssuePerson | null;
  assignees: IssuePerson[];
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  commentCount: number | null;
  milestone: string | null;
  /** When the file was written, if it says. */
  fetchedAt: string | null;
  excerpt: string;
}

export interface IssueDetail extends IssueSummary {
  /** GitHub bodies are Markdown; Azure DevOps descriptions are HTML. */
  bodyFormat: 'markdown' | 'html';
  body: string;
  /** The provider's untouched object, for the raw view. */
  raw: unknown;
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

/* ---------------------------------------------------------- live updates */

/**
 * Which store changed.
 *
 * The CLI, an agent and this app all write to the same workspace, so the page is
 * routinely looking at data another process has just replaced. The server
 * watches the two stores and says which one moved; the client decides what that
 * means for whatever is on screen.
 */
export const CHANGE_CHANNELS = ['tasks', 'notes'] as const;
/** `tasks` is the database — tasks, investigations, branches, agent runs.
 *  `notes` is the notes folder, which backs both Notes and Issues. */
export type ChangeChannel = (typeof CHANGE_CHANNELS)[number];

export interface ChangeEvent {
  channel: ChangeChannel;
  /** Monotonic per channel, so a reconnecting client can tell it missed one. */
  revision: number;
  at: string;
}

/* ------------------------------------------------------------ agent runs */

/**
 * Running an agent CLI from the UI.
 *
 * Two harnesses are understood — Claude Code and `pi` — and one prompt is built
 * for both, because the slash commands this drives (`/plan-tasks`, `/work-task`)
 * are installed in both. Nothing here is provider-specific beyond the argv a
 * harness wants; see `src/server/agents.ts`.
 */
export const AGENT_HARNESSES = ['claude', 'pi'] as const;
export type AgentHarnessId = (typeof AGENT_HARNESSES)[number];

/** Which of the two slash commands a run drives. */
export const AGENT_COMMANDS = ['plan-tasks', 'work-task'] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

/**
 * How the agent is launched.
 *
 * `terminal` opens a real terminal window with the agent interactive inside it —
 * you can answer its questions, steer it, and watch it work. Nothing is captured
 * because the terminal *is* the session.
 *
 * `print` runs it headless with `-p`, detached from any terminal, and captures
 * stdout/stderr to a log this app streams back.
 */
export const AGENT_RUN_MODES = ['terminal', 'print'] as const;
export type AgentRunMode = (typeof AGENT_RUN_MODES)[number];

export type AgentRunStatus = 'launched' | 'running' | 'succeeded' | 'failed' | 'stopped';

export interface AgentModel {
  /** Passed to the harness as `--model`. */
  id: string;
  label: string;
  /** Provider, or whatever groups the list — used for `<optgroup>`. */
  group: string | null;
}

/** One harness, as the dialog needs to render it. */
export interface AgentHarnessInfo {
  id: AgentHarnessId;
  label: string;
  /** The executable, e.g. `claude`. */
  bin: string;
  /** Whether that executable is on PATH. */
  available: boolean;
  /** True when models have to be fetched separately (the list is slow/large). */
  modelsLazy: boolean;
}

/** What the Investigate / Work buttons need before they can offer a run. */
export interface AgentEnvironment {
  harnesses: AgentHarnessInfo[];
  /** The terminal emulator that `terminal` mode will use, if one was found. */
  terminal: string | null;
  /** Whether the whole terminal mode is available at all. */
  terminalAvailable: boolean;
}

/** One launch of an agent, recorded so a run outlives the tab that started it. */
export interface AgentRun {
  id: number;
  harness: AgentHarnessId;
  /** Empty when the harness default was used. */
  model: string;
  mode: AgentRunMode;
  command: AgentCommand;
  /** What the run is about — `issue`, `task` or `investigation` plus its ref. */
  subjectKind: string;
  subjectRef: string;
  /** The prompt actually sent, slash command and all. */
  prompt: string;
  /** The argv spawned, for when a run does something surprising. */
  argv: string[];
  pid: number | null;
  status: AgentRunStatus;
  exitCode: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A run plus whatever its log holds. Only `print` runs have output. */
export interface AgentRunDetail extends AgentRun {
  output: string;
  /** True when `output` is the tail of a longer log. */
  truncated: boolean;
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
