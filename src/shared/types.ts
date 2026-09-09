/** Types shared by the CLI, the bun server and the Vue app. */

export const STATUSES = [
  "backlog",
  "in_progress",
  "dev_complete",
  "verified",
  "closed",
] as const
export type Status = (typeof STATUSES)[number]

export const STATUS_LABELS: Record<Status, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  dev_complete: "Dev Complete",
  verified: "Verified",
  closed: "Closed",
}

export const PRIORITIES = ["low", "medium", "high"] as const
export type Priority = (typeof PRIORITIES)[number]

/**
 * How capable a model a task needs, decoupled from any real model name.
 *
 * The point of a tier is that it outlives a model lineup: `frontier` means
 * "whatever the harness's top model is today", not a pinned id. `src/config/config.ts`
 * maps each tier to a real model per harness, and that mapping is the only
 * place a concrete model name is allowed to live outside a harness definition.
 */
export const MODEL_TIERS = ["fast", "standard", "frontier"] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const MODEL_TIER_LABELS: Record<ModelTier, string> = {
  fast: "Fast",
  standard: "Standard",
  frontier: "Frontier",
}

/** Which checkpoint phase a capture belongs to. */
export type Phase = "before" | "after"

/** Per-scenario outcome, mirroring aio-vr's own vocabulary. */
export type ComparisonStatus =
  "unchanged" | "changed" | "failed" | "new-baseline"

export const INVESTIGATION_STATUSES = [
  "draft",
  "investigating",
  "complete",
] as const
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number]

export const INVESTIGATION_STATUS_LABELS: Record<InvestigationStatus, string> =
  {
    draft: "Draft",
    investigating: "Investigating",
    complete: "Complete",
  }

export interface Task {
  id: number
  ref: string
  title: string
  description: string
  status: Status
  priority: Priority
  /** Where the task sits in the manually ordered list — lower is nearer the top.
   *  The top of the list is what `/work-task` picks up when given no ref, so this
   *  is the work queue, not a cosmetic preference. Dense but not guaranteed
   *  contiguous: a reorder only permutes the positions it was handed. */
  position: number
  tags: string[]
  /** How long the task takes on the plan, in abstract units — see
   *  `DEFAULT_ESTIMATE_UNITS`. Deliberately not hours: the schedule view orders
   *  work, it does not date it. */
  estimateUnits: number
  /** The investigation that filed this task, when one did. Plain ref, not a
   *  foreign key — a task outlives the investigation that produced it. */
  investigationRef: string | null
  /** The capability tier an investigating agent thinks this task needs, or null
   *  when nobody has judged it. A hint for the model dropdown in
   *  `AgentRunDialog`, not a constraint — the person running the task can
   *  always pick something else. */
  recommendedTier: ModelTier | null
  /** The group this task belongs to, or null when it is loose. A plain ref for
   *  the same reason as `investigationRef`: the group is a way of reading the
   *  list, and deleting one must not take its tasks with it. */
  groupRef: string | null
  /** Refs of the tasks this one waits on, nearest the top of the list first.
   *  Plain refs rather than ids, so the shape matches how everything else here
   *  addresses a task. */
  dependsOn: string[]
  /** Refs of the tasks waiting on this one — the other side of `dependsOn`,
   *  materialised so a list view can mark a blocker without a second request. */
  blocks: string[]
  /** The Git branch assigned when the task is created. Legacy completed tasks may not have one. */
  branchName: string | null
  checkpointName: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  devCompletedAt: string | null
  verifiedAt: string | null
  closedAt: string | null
}

/**
 * How long a task takes when nobody says otherwise.
 *
 * The plan's time axis is units, not hours — one unit is "a task", and most
 * tasks are one of them. Anything bigger is the exception a human types in, so
 * the default has to be the common case rather than an empty field.
 */
export const DEFAULT_ESTIMATE_UNITS = 1

/** The largest estimate accepted. Not a real limit on work, just a guard against
 *  a typo'd `100` becoming a chart nothing can render. */
export const MAX_ESTIMATE_UNITS = 999

/** Coerce anything into a usable estimate, or throw saying why it is not one. */
export function parseEstimateUnits(value: unknown): number {
  const units = typeof value === "string" ? Number(value.trim()) : value
  if (
    typeof units !== "number" ||
    !Number.isInteger(units) ||
    units < 1 ||
    units > MAX_ESTIMATE_UNITS
  ) {
    throw new Error(
      `An estimate must be a whole number of units between 1 and ${MAX_ESTIMATE_UNITS}.`,
    )
  }
  return units
}

/**
 * Statuses that satisfy a dependency.
 *
 * A blocker counts as done once its work exists on its branch — that is what
 * the next task actually needs — so `dev_complete` is enough. Waiting for
 * `verified` would mean a human sign-off gates work that is already unblocked.
 */
export const DEPENDENCY_SATISFIED_STATUSES: readonly Status[] = [
  "dev_complete",
  "verified",
  "closed",
]

/** Whether a blocker's status still holds up the tasks that depend on it. */
export function satisfiesDependency(status: Status): boolean {
  return DEPENDENCY_SATISFIED_STATUSES.includes(status)
}

/**
 * The blockers of `task` that are not done yet, given whatever tasks are to
 * hand. Refs that are not in `known` are skipped rather than assumed blocking:
 * a filtered list is a partial view, not evidence that a task is gone.
 */
export function unmetDependencies(task: Task, known: Iterable<Task>): Task[] {
  if (!task.dependsOn.length) return []
  const byRef = new Map<string, Task>()
  for (const one of known) byRef.set(one.ref.toLowerCase(), one)

  return task.dependsOn
    .map((ref) => byRef.get(ref.toLowerCase()))
    .filter(
      (blocker): blocker is Task =>
        !!blocker && !satisfiesDependency(blocker.status),
    )
}

/**
 * The given tasks in an order they can actually be worked: nothing comes before
 * something it depends on.
 *
 * A stable topological sort — tasks are visited in the order handed in, which is
 * the manual queue order, and a task is emitted only after the dependencies that
 * are *also in this set* have been. Dependencies outside the set are left alone:
 * they cannot be reordered from here, and a task waiting on one is still
 * reported as blocked by `unmetDependencies`, which is where that belongs.
 *
 * Cycles cannot be created through the API, but a cycle here would be an
 * infinite descent rather than a bad order, so one is broken by emitting the
 * task that closes it in queue order.
 */
export function dependencyOrder(tasks: Task[]): Task[] {
  const inSet = new Map(tasks.map((task) => [task.ref.toLowerCase(), task]))
  const emitted = new Set<string>()
  const visiting = new Set<string>()
  const ordered: Task[] = []

  const visit = (task: Task): void => {
    const key = task.ref.toLowerCase()
    if (emitted.has(key) || visiting.has(key)) return
    visiting.add(key)
    for (const ref of task.dependsOn) {
      const blocker = inSet.get(ref.toLowerCase())
      if (blocker) visit(blocker)
    }
    visiting.delete(key)
    emitted.add(key)
    ordered.push(task)
  }

  for (const task of tasks) visit(task)
  return ordered
}

export interface TaskEvent {
  id: number
  taskId: number
  type: "created" | "status" | "edited" | "note" | "checkpoint"
  fromStatus: Status | null
  toStatus: Status | null
  note: string | null
  createdAt: string
}

/**
 * One pair of images and what differs between them — everything a comparison
 * card draws.
 *
 * Shared by the two things that produce such a pair, which are the same
 * question asked against different references: a task checkpoint compares the
 * work-in-progress against what the page looked like before the task started,
 * and a baseline run compares it against the last approved state.
 */
export interface VisualComparison {
  scenario: string
  description: string | null
  status: ComparisonStatus
  percentChanged: number | null
  pixelDiffCount: number | null
  totalPixels: number | null
  /** Repo-root-relative paths; the server streams them through /api/image. */
  beforePath: string | null
  afterPath: string | null
  diffPath: string | null
  browserLogStatus: string | null
  browserLogChangeCount: number | null
}

export interface Comparison extends VisualComparison {
  id: number
  runId: number
}

export interface CheckpointRun {
  id: number
  taskId: number
  checkpointName: string
  phase: Phase
  exitCode: number
  gitHead: string | null
  gitDirty: number | null
  scenarioCount: number
  /** The --scenario / --folder filters this run used, if any. */
  selection: { scenarios?: string[]; folders?: string[] } | null
  createdAt: string
  comparisons: Comparison[]
}

/**
 * A file attached to a task — a screenshot, most often.
 *
 * Stored on disk rather than in the database, one folder per task, so an agent
 * working the task can read `absolutePath` with its own file tools rather than
 * going through this app at all. `tasks show <ref> --json` surfaces this array
 * verbatim for exactly that reason.
 */
export interface TaskAttachment {
  name: string
  /** Path relative to the attachments root, as the server serves it. */
  path: string
  /** Absolute path on disk — the only field an agent's Read tool needs. */
  absolutePath: string
  size: number
  isImage: boolean
}

/** A task plus everything the detail view needs. */
export interface TaskDetail extends Task {
  events: TaskEvent[]
  runs: CheckpointRun[]
  attachments: TaskAttachment[]
}

/* ------------------------------------------------------------------ groups */

/**
 * A named bundle of tasks — a feature, a release, an investigation's output.
 *
 * Deliberately not a tag: a task belongs to at most one group, groups are
 * ordered, and both the list and the plan draw them as sections. Tags stay what
 * they are — free-form labels a task can carry any number of.
 *
 * Membership lives on the task (`Task.groupRef`), not in a join table, which is
 * what makes "one group per task" a fact of the schema rather than a rule
 * something has to enforce.
 */
export interface TaskGroup {
  id: number
  /** `G-<n>`, counted separately from tasks and investigations. */
  ref: string
  name: string
  description: string
  /** `#rrggbb`, used for the band on the plan and the dot in the list. Assigned
   *  from `GROUP_COLORS` when nobody picks one. */
  color: string
  /**
   * The branch this group's work is built on. Every group has one: members are
   * cut from it rather than from the base branch, and `tasks done` merges each
   * member back into it, so the group is deliverable as a single PR.
   */
  branchName: string
  /** Where the group sits among the others. Only decides the order of *empty*
   *  groups and ties — a group with tasks in it is ordered by the first of them
   *  in the queue, so the grouped list reads in the same order as the flat one. */
  position: number
  /** The investigation whose tasks this group collects, when it was created for
   *  one. Set by the auto-grouping in `createTask`, and what makes that
   *  idempotent — a second run of the same investigation refills the same group. */
  investigationRef: string | null
  createdAt: string
  updatedAt: string
}

/** A group plus how much is in it — what a list of groups actually needs. */
export interface TaskGroupSummary extends TaskGroup {
  taskCount: number
  /** Members whose implementation is finished. This includes tasks that have
   *  subsequently moved on to verification or closure. */
  devCompleteCount: number
  /** Members that are not closed. The count worth showing: a group whose work
   *  is finished should not read as a group with ten open tasks in it. */
  openCount: number
}

/**
 * The colours a group is assigned from, in order.
 *
 * A fixed list rather than a generator: these are picked to stay legible as a
 * 3px band on both themes, and a group's colour has to be stable enough that
 * people learn it.
 */
export const GROUP_COLORS = [
  "#5b9dff",
  "#4ec98a",
  "#e0a03a",
  "#c678dd",
  "#f2555a",
  "#3fb8c4",
  "#e58f65",
  "#8b93f8",
] as const

/** The next colour to hand out, given what is already taken. Falls back to
 *  cycling once every colour is in use — a repeat is better than a blank. */
export function nextGroupColor(taken: Iterable<string>): string {
  const used = new Set([...taken].map((color) => color.toLowerCase()))
  return (
    GROUP_COLORS.find((color) => !used.has(color)) ??
    GROUP_COLORS[used.size % GROUP_COLORS.length]!
  )
}

/** Whether a string is a colour this app will store. Hex only, so a value read
 *  back can go straight into a style attribute. */
export function isGroupColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * Split tasks into their groups, in the order the views draw them.
 *
 * Shared by the list and the plan so the two never disagree about what the
 * grouping *is*. Section order follows the first member in the given task order
 * — which is the queue — so the row at the top of a grouped list is still the one
 * `/work-task` takes. Sectioning only reads as queue order while each group's
 * tasks are contiguous, which is what `setTaskGroup` maintains as tasks join a
 * group; a task taken out of one is left where it was rather than the queue
 * being shuffled behind the user to preserve the appearance. The loose tasks are a section like any other for that reason, rather
 * than a footer: pinning them last would move whatever is at the top of the
 * queue down the page for no better reason than that nobody has grouped it.
 * Groups with nothing in them have no first member, so they come after.
 */
export interface TaskGrouping<T> {
  group: TaskGroup | null
  items: T[]
}

export function groupTasks<T>(
  items: T[],
  groups: TaskGroup[],
  taskOf: (item: T) => Task,
): TaskGrouping<T>[] {
  const byRef = new Map(groups.map((group) => [group.ref.toLowerCase(), group]))
  const buckets = new Map<string, T[]>()
  // Insertion order *is* the answer for a section with something in it: its
  // first task decides where it sits. `''` keys the loose one.
  const seen: string[] = []

  for (const item of items) {
    const ref = taskOf(item).groupRef?.toLowerCase()
    // A ref pointing at a group this view was not handed reads as loose rather
    // than inventing a section nothing can name.
    const key = ref && byRef.has(ref) ? ref : ""
    if (!buckets.has(key)) {
      buckets.set(key, [])
      seen.push(key)
    }
    buckets.get(key)!.push(item)
  }

  const result: TaskGrouping<T>[] = seen.map((key) => ({
    group: key ? byRef.get(key)! : null,
    items: buckets.get(key)!,
  }))

  const empty = groups
    .filter((group) => !buckets.has(group.ref.toLowerCase()))
    .sort((left, right) => left.position - right.position || left.id - right.id)
  for (const group of empty) result.push({ group, items: [] })

  return result
}

/* ------------------------------------------------------------ investigations */

/**
 * A question written down before anyone goes looking. The human writes `brief`;
 * an agent runs it via `/plan-tasks`, writes `findings` back, and files the work
 * it turned up as tasks pointing at this ref.
 */
export interface Investigation {
  id: number
  ref: string
  title: string
  /** What to investigate — the human's input, free-form Markdown. */
  brief: string
  /** What the agent concluded. Empty until an investigation has been run. */
  findings: string
  status: InvestigationStatus
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

/** An investigation plus the tasks it produced. */
export interface InvestigationDetail extends Investigation {
  tasks: Task[]
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
  path: string
  /** Frontmatter `title`, falling back to the filename. */
  title: string
  tags: string[]
  /** Directory the note sits in, `''` at the root. */
  folder: string
  /** First couple of lines of prose, for the list column. */
  excerpt: string
  createdAt: string
  updatedAt: string
}

/** A file stored alongside a note — an image, a PDF, a dropped screenshot. */
export interface NoteAttachment {
  name: string
  /** Path relative to the notes root, as the server serves it. */
  path: string
  /** Path as it is written in the Markdown, relative to the note itself. */
  href: string
  size: number
  isImage: boolean
  /**
   * True when this app put the file under `attachments/`, false when it was
   * simply found sitting beside the note.
   *
   * The difference is who owns the file. An upload belongs to the note and can
   * be removed with it; an image someone dropped into the folder by hand may be
   * referenced by a second note, synced from Obsidian, or the reason the folder
   * exists — so the UI shows it without offering to delete it.
   */
  uploaded: boolean
}

/** A note plus its body and attachments — what the detail view edits. */
export interface Note extends NoteSummary {
  /** The Markdown below the frontmatter. */
  body: string
  attachments: NoteAttachment[]
}

/** Live Git state of the notes folder. Read fresh per request: it is an ordinary
 *  repository somebody may commit to, pull or push from outside this app. */
export interface NotesGitInfo {
  /** False when the folder exists but was never `git init`ed. */
  repo: boolean
  branch: string | null
  /** Paths with uncommitted changes. */
  dirty: number
  lastCommit: { shortSha: string; subject: string; date: string } | null
  upstream: string | null
  /** Commits not yet pushed. Null when there is no upstream to compare with. */
  unpushed: number | null
}

/** Where the notes live and what state that folder is in. */
export interface NotesWorkspaceInfo {
  /** Absolute path to the notes folder. */
  dir: string
  exists: boolean
  /** Whether a write commits automatically (`notesAutoCommit`). */
  autoCommit: boolean
  git: NotesGitInfo
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
export type IssueState = "open" | "closed"

/** Providers recognised by name. Anything else still renders, badged as itself. */
export const ISSUE_SOURCES = ["github", "azure-devops"] as const
export type IssueSource = (typeof ISSUE_SOURCES)[number]

export const ISSUE_SOURCE_LABELS: Record<string, string> = {
  github: "GitHub",
  "azure-devops": "Azure DevOps",
}

export interface IssueLabel {
  name: string
  /** `#rrggbb`, when the provider has an opinion. Azure DevOps tags do not. */
  color: string | null
  description: string | null
}

export interface IssuePerson {
  name: string
  avatarUrl: string | null
  url: string | null
}

export interface IssueSummary {
  /** Identity: the file's path relative to the notes root, plus `#<index>` when
   *  one file holds several issues. */
  id: string
  /** The file it came from. */
  path: string
  /** `github`, `azure-devops`, or whatever the file called itself. */
  source: string
  /** The provider's own reference, e.g. `#677`. */
  key: string
  title: string
  /** Normalised for filtering. */
  state: IssueState
  /** The provider's own wording — `open`, `Active`, `Resolved`, `not_planned`. */
  stateLabel: string
  /** Where to open it in a browser. */
  url: string | null
  /** The repository or project it belongs to. */
  container: string | null
  /** Bug, Feature, User Story — whatever the provider calls its types. */
  kind: string | null
  labels: IssueLabel[]
  author: IssuePerson | null
  assignees: IssuePerson[]
  createdAt: string | null
  updatedAt: string | null
  closedAt: string | null
  commentCount: number | null
  milestone: string | null
  /** When the file was written, if it says. */
  fetchedAt: string | null
  excerpt: string
}

export interface IssueDetail extends IssueSummary {
  /** GitHub bodies are Markdown; Azure DevOps descriptions are HTML. */
  bodyFormat: "markdown" | "html"
  body: string
  /** The provider's untouched object, for the raw view. */
  raw: unknown
}

/* -------------------------------------------------------------- baselines */

/**
 * One scenario measured against its **approved baseline**, rather than against
 * a task's starting point.
 *
 * This is the other half of the visual story. A checkpoint answers "did my
 * change move anything?", scoped to one task and thrown away when it closes. A
 * baseline answers "does the app still look the way we agreed it should?", and
 * it outlives every task — drift accumulates there whether or not anyone was
 * working on it.
 */
export interface BaselineScenario extends VisualComparison {
  /** Where the scenario is defined, so the page can name the file to edit. */
  scenarioPath: string | null
  /** The percentage below which aio-vr calls a difference nothing. */
  threshold: number | null
  /** When this scenario last ran. */
  timestamp: string | null
  durationMs: number | null
  /** Whether the current difference has already been signed off. Read from
   *  aio-vr's approvals file, which is what `aio-vr approve` writes. */
  approved: boolean
  approvedAt: string | null
  /** What the scenario looked like when it was approved — a scenario approved
   *  while `changed` was a deliberate acceptance, not a clean run. */
  statusAtApproval: string | null
  /** The browser console log's own diff, when one was written. */
  browserLogDiffPath: string | null
}

/** Everything the Baselines view draws: the last full run, and what it found. */
export interface BaselineReport {
  /** False when aio-vr has never run here — the view says so rather than
   *  showing an empty list that looks like "nothing has drifted". */
  hasRun: boolean
  /** When the results file was written. */
  generatedAt: string | null
  /** aio-vr's own tally, by status. */
  totals: Record<string, number>
  scenarios: BaselineScenario[]
  /** Repo-root-relative path of the results file, as configured in
   *  `aio-vr.config.json`. Shown so a surprising report can be traced. */
  resultsPath: string
  /** False when the `aio-vr` executable is not on PATH — running and approving
   *  are unavailable, but a previous run's results still read fine. */
  available: boolean
}

/* ------------------------------------------------------ combined branches */

/** One delivery branch built by combining several task branches. Recorded when
 *  the combine succeeds, so the branch outlives the tasks being closed. */
/* -------------------------------------------------------------- pr checks */

/** One check's outcome.
 *
 *  `skipped` is a pass — the check watches paths this branch never touched, so
 *  it has nothing to say about it. `error` is not: the check could not be run at
 *  all (a cwd that does not exist), and a check nobody can run must never be
 *  mistaken for a check with nothing to say. */
export interface CheckRun {
  name: string
  command: string[]
  /** Repo-root-relative working directory it ran in. */
  cwd: string
  status: "passed" | "failed" | "skipped" | "timed_out" | "error"
  /** Why it was skipped, or what is wrong with its configuration. */
  reason?: string
  exitCode: number | null
  durationMs: number
  /** Combined stdout and stderr, truncated from the front when long. */
  output: string
}

/** A run currently in flight. Checks outlive the request that starts them, so
 *  this is how a page follows one that is still going. */
export interface ChecksProgress {
  branch: string
  base: string
  startedAt: string
  /** The check being run right now, or null before the first one starts. */
  current: string | null
  done: number
  total: number
}

/** One run of the whole suite against one branch — what gates the PR button. */
export interface ChecksReport {
  branch: string
  base: string
  /** The commit the branch was on. New commits since make this report stale. */
  headSha: string | null
  ranAt: string
  passed: boolean
  /** The branch actually checked out while the commands ran. Checks read the
   *  working tree, so a different branch here means the report describes that
   *  tree, not this branch. */
  ranOnBranch: string | null
  checks: CheckRun[]
}

export interface CombinedBranch {
  id: number
  branchName: string
  /** The branch the combine was cut from — the PR's base by default. */
  baseBranch: string | null
  /** The name to push and open the PR's head under. Null means push under
   *  `branchName` itself, the historical default. */
  remoteBranch: string | null
  /** Refs of the tasks cherry-picked in, in combine order. */
  taskRefs: string[]
  prTitle: string | null
  prBody: string | null
  prUrl: string | null
  prNumber: number | null
  /** A combine stopped on a Git conflict and needs `git cherry-pick --continue`. */
  combineState: "complete" | "conflict"
  /** Commits still to cherry-pick after a conflict is resolved. */
  combinePendingCommits: string[]
  /** Whether tasks should be closed when this combine finishes. */
  combineCloseTasks: boolean
  /** The last pre-PR check run, or null if none has been run here. */
  checks: ChecksReport | null
  createdAt: string
  updatedAt: string
}

export interface BranchCommit {
  sha: string
  shortSha: string
  subject: string
  author: string
  date: string
}

/** Live Git state for a branch. Read fresh on every request — a branch can be
 *  deleted, pushed or advanced from outside this app at any time. */
export interface BranchGitInfo {
  exists: boolean
  /** Set when the branch has a configured upstream, e.g. `origin/feature/x`. */
  upstream: string | null
  /** Commits unique to this branch relative to its base, oldest first. */
  commits: BranchCommit[]
  filesChanged: number
  /** Null when the base branch cannot be resolved (deleted, renamed). */
  aheadOfBase: number | null
}

/** A combined branch plus its live Git state and the tasks it carries. */
export interface CombinedBranchDetail extends CombinedBranch {
  git: BranchGitInfo
  tasks: Task[]
  /** Set while a check run is in flight for this branch. */
  checksRunning: ChecksProgress | null
}

/* ------------------------------------------------------------ group detail */

/**
 * Everything the group page shows: the group, its tasks, the order they can be
 * worked in, and the live state of the branch they all sit on.
 *
 * The delivery record is the same `combined_branches` row `tasks done` registers
 * each merged task on, so the group page and the Branches view are two readings
 * of one fact rather than two sources of truth.
 */
export interface TaskGroupDetail extends TaskGroupSummary {
  tasks: Task[]
  /** The unfinished tasks, in dependency order — what an agent works through. */
  queue: Task[]
  /**
   * Blockers of the queued tasks that live outside this group and are **not
   * finished**. Only unmet ones: a closed or dev-complete dependency is work
   * that already exists, so it is nothing for the group to wait on.
   *
   * Resolved on the server because it is the only place every task is visible —
   * the page is handed this group's tasks and could not otherwise tell a
   * finished outside dependency from an unfinished one.
   */
  outsideBlockers: Task[]
  /**
   * Tasks anywhere in the workspace that are currently `in_progress` — not just
   * this group's.
   *
   * `/work-task` refuses to start a second task while one is in flight, because
   * each task owns a branch and a visual checkpoint and two at once corrupts
   * both. The page has to apply the same rule to say honestly whether the next
   * task can be started, and a task in another group blocks it just as much.
   */
  inProgress: Task[]
  /** What the group branch is cut from, and what its PR would target. */
  baseBranch: string
  git: BranchGitInfo
  /** Null until the first task is merged into the group branch. */
  delivery: CombinedBranch | null
  /**
   * The unattended run working through this group right now, or the last one to
   * have tried — null when the group has never been run that way.
   *
   * Read with the rest of the group because it is not a detail of the run
   * history: a group with a loop in flight is in a different state, and every
   * button on the page has to know that before it offers to start anything.
   */
  run: GroupRun | null
}

/**
 * What became of one task when its whole group was signed off in a single go.
 *
 * Signing off a group is not all-or-nothing — unfinished work is left where it
 * is, and one task failing does not hold up the others — so the caller is told
 * about every member rather than just handed a count.
 */
export interface GroupAdvanceOutcome {
  ref: string
  title: string
  from: Status
  /** Where it ended up, or null when it did not move at all. */
  to: Status | null
  /** Why nothing was attempted for it. */
  skipped?: string
  /** Why what was attempted did not land. */
  error?: string
}

/** Which external CLIs the Branches view can use, and what they are called. */
export interface ToolAvailability {
  /** The configured PR-description agent, or null when the feature is off. */
  prAgent: string | null
  prAgentAvailable: boolean
  /** How many pre-PR checks this repository configures. 0 leaves PRs ungated. */
  checkCount: number
  gh: boolean
  ghAuthed: boolean
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
export const CHANGE_CHANNELS = ["tasks", "notes"] as const
/** `tasks` is the database — tasks, investigations, branches, agent runs.
 *  `notes` is the notes folder, which backs both Notes and Issues. */
export type ChangeChannel = (typeof CHANGE_CHANNELS)[number]

export interface ChangeEvent {
  channel: ChangeChannel
  /** Monotonic per channel, so a reconnecting client can tell it missed one. */
  revision: number
  at: string
}

/* ------------------------------------------------------------ agent runs */

/**
 * Running an agent CLI from the UI.
 *
 * Three harnesses are understood — Claude Code, Codex and `pi` — and one prompt
 * is built for all of them: the command's full instructions live as Markdown in this package's
 * `prompts/` folder and are inlined into the initial message, so a run needs
 * nothing installed beyond the harness binary itself. Nothing here is
 * provider-specific beyond the argv a harness wants; see `src/server/agents.ts`.
 */
export const AGENT_HARNESSES = ["claude", "codex", "pi"] as const
export type AgentHarnessId = (typeof AGENT_HARNESSES)[number]

/** Which in-repo prompt file (`prompts/<name>.md`) a run drives. */
export const AGENT_COMMANDS = [
  "plan-tasks",
  "work-task",
  "work-group",
  "resolve-checks",
] as const
export type AgentCommand = (typeof AGENT_COMMANDS)[number]

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
export const AGENT_RUN_MODES = ["terminal", "print"] as const
export type AgentRunMode = (typeof AGENT_RUN_MODES)[number]

/**
 * How much the agent may do without asking. Harness definitions translate this
 * vocabulary to their own permission and sandbox flags.
 *
 * `manual` is expressed by passing no permission flag, leaving the harness's
 * own default intact. This list is the app's vocabulary rather than a mirror of
 * any one CLI's option names.
 */
export const AGENT_PERMISSION_MODES = [
  "manual",
  "auto",
  "plan",
  "bypassPermissions",
] as const
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number]

export const AGENT_PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> =
  {
    manual: "Ask every time",
    auto: "Auto",
    plan: "Plan only",
    bypassPermissions: "Never ask",
  }

export type AgentRunStatus =
  "launched" | "running" | "succeeded" | "failed" | "stopped"

export interface AgentModel {
  /** Passed to the harness as `--model`. */
  id: string
  label: string
  /** Provider, or whatever groups the list — used for `<optgroup>`. */
  group: string | null
}

/** One harness, as the dialog needs to render it. */
export interface AgentHarnessInfo {
  id: AgentHarnessId
  label: string
  /** The executable, e.g. `claude`. */
  bin: string
  /** Whether that executable is on PATH. */
  available: boolean
  /** True when models have to be fetched separately (the list is slow/large). */
  modelsLazy: boolean
}

/** What the Investigate / Work buttons need before they can offer a run. */
export interface AgentEnvironment {
  harnesses: AgentHarnessInfo[]
  /** The terminal emulator that `terminal` mode will use, if one was found. */
  terminal: string | null
  /** Whether the whole terminal mode is available at all. */
  terminalAvailable: boolean
  /** Each harness's tier → model mapping, from `tasks.config.json`. A harness
   *  with no entry (or a tier with no entry within it) has nothing to
   *  recommend for that tier, so the dialog falls back to its own default. */
  modelTiers: Partial<
    Record<AgentHarnessId, Partial<Record<ModelTier, string>>>
  >
}

/** One launch of an agent, recorded so a run outlives the tab that started it. */
export interface AgentRun {
  id: number
  harness: AgentHarnessId
  /** Empty when the harness default was used. */
  model: string
  mode: AgentRunMode
  command: AgentCommand
  /** What the run is about — `issue`, `task` or `investigation` plus its ref. */
  subjectKind: string
  subjectRef: string
  /** The prompt actually sent, inlined command instructions and all. */
  prompt: string
  /** The argv spawned, for when a run does something surprising. */
  argv: string[]
  pid: number | null
  /**
   * The harness conversation this run created, so it can be reopened.
   *
   * Claude Code and pi accept the id generated by this app. Codex creates its
   * own, so headless runs capture the id it reports; terminal Codex runs cannot
   * expose one to this process. Null when no reliable id is available.
   */
  sessionId: string | null
  status: AgentRunStatus
  exitCode: number | null
  createdAt: string
  finishedAt: string | null
}

/** A run plus whatever its log holds. Only `print` runs have output. */
export interface AgentRunDetail extends AgentRun {
  output: string
  /** True when `output` is the tail of a longer log. */
  truncated: boolean
}

/* ------------------------------------------------------------ group runs */

/**
 * Working a whole group unattended, one fresh agent per task.
 *
 * This is not `/work-group` — that command is a loop *inside* one conversation,
 * which is the thing it is worth avoiding: by the fifth task the session is
 * carrying four tasks' worth of context that has nothing to do with the fifth.
 * A group run is the same loop turned inside out. Each task gets its own
 * headless `/work-task` process with an empty context, and this server is what
 * remembers the order and what has been done.
 *
 * The signal to move on is the agent process exiting, which this server sees
 * directly because it is the parent. What it is *not* allowed to be is the exit
 * code alone: `claude -p` exits 0 when it stops for a perfectly good reason —
 * a merge conflict, a question, a dependency it will not decide about. So a
 * task counts as done only when the database says it reached `dev_complete`,
 * which is `tasks done` having actually run. Anything else stops the loop.
 */
export const GROUP_RUN_STATUSES = [
  "running",
  "finished",
  "stopped",
  "blocked",
  "failed",
] as const
export type GroupRunStatus = (typeof GROUP_RUN_STATUSES)[number]

export const GROUP_RUN_STATUS_LABELS: Record<GroupRunStatus, string> = {
  running: "Running",
  finished: "Finished",
  stopped: "Stopped",
  blocked: "Needs attention",
  failed: "Failed",
}

export interface GroupRun {
  id: number
  groupRef: string
  /** The launch settings every task in the loop is worked with. Chosen once, at
   *  the start, because changing harness halfway through a group would make the
   *  run mean two different things. */
  harness: AgentHarnessId
  model: string
  permissionMode: AgentPermissionMode
  /** Extra prompt text appended to every task's `/work-task`. */
  extra: string
  status: GroupRunStatus
  /** The `agent_runs` row working right now, or the last one that worked. */
  currentRunId: number | null
  /** What that run is pointed at. */
  currentRef: string | null
  /** Task refs this loop has carried to Dev Complete, in the order it did. */
  worked: string[]
  /** Tasks deliberately left out when this run was started. */
  excluded: string[]
  /** Why it is no longer running. Empty while it still is. */
  stopReason: string
  createdAt: string
  finishedAt: string | null
}

/** True while the loop still owns the group — nothing else should start a task. */
export function groupRunActive(run: GroupRun | null | undefined): boolean {
  return !!run && run.status === "running"
}

/* ----------------------------------------------------------- queue choice */

/**
 * What is holding up each queued task, resolved against what the group can see.
 *
 * The group's own tasks plus the unfinished outside blockers the server found
 * is the whole universe that matters here: anything else a task depends on is
 * finished work, and `unmetDependencies` skipping a ref it cannot see is
 * exactly right for that reason.
 */
export function groupQueueBlockers(
  detail: Pick<TaskGroupDetail, "tasks" | "queue" | "outsideBlockers">,
): Map<string, Task[]> {
  const known = [...detail.tasks, ...detail.outsideBlockers]
  const map = new Map<string, Task[]>()
  for (const task of detail.queue) {
    const waiting = unmetDependencies(task, known)
    if (waiting.length) map.set(task.ref, waiting)
  }
  return map
}

/**
 * The task to work next: the first in the work order that nothing unfinished is
 * holding up.
 *
 * Not simply `queue[0]` — the order guarantees dependencies come first, but the
 * top of it can still be blocked by something outside the group, and the point
 * of this is to name a task that can actually be started now.
 *
 * Shared between the page and the loop deliberately. They have to agree about
 * which task is next, and two implementations of "next" is how they would stop
 * agreeing.
 */
export function nextWorkableTask(
  detail: Pick<TaskGroupDetail, "tasks" | "queue" | "outsideBlockers">,
): Task | null {
  const blocked = groupQueueBlockers(detail)
  return detail.queue.find((task) => !blocked.has(task.ref)) ?? null
}

/** Whether a task's before/after screenshots are ready to look at. */
export function hasVisualEvidence(
  task: Pick<Task, "status">,
  runs: CheckpointRun[],
): boolean {
  return runs.some((run) => run.phase === "after" && run.comparisons.length > 0)
}

/** Checkpoint name derived from a task ref. Kept in one place so the CLI, the
 *  server and the UI never disagree about which checkpoint belongs to a task. */
export function checkpointNameFor(ref: string, prefix = "task-"): string {
  return `${prefix}${ref.toLowerCase()}`
}

/** The `some-title-here` half of a generated branch name. */
function branchSlug(title: string, fallback: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback
  )
}

/** A deterministic, Git-friendly default branch for a task. */
export function branchNameFor(
  ref: string,
  title: string,
  prefix = "feature/",
): string {
  return `${prefix}${ref.toLowerCase()}-${branchSlug(title, "task")}`
}

/**
 * A deterministic, Git-friendly default branch for a group.
 *
 * A group's branch is the base its members are cut from and merged back into,
 * so it lives under its own prefix: `group/g-3-search-rework` never collides
 * with a task's `feature/t-12-...`, and a glance at a branch list says which
 * kind of branch it is.
 */
export function groupBranchNameFor(
  ref: string,
  name: string,
  prefix = "group/",
): string {
  return `${prefix}${ref.toLowerCase()}-${branchSlug(name, "group")}`
}
