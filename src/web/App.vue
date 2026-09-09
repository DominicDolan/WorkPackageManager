<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import {
  DEFAULT_ESTIMATE_UNITS,
  GROUP_COLORS,
  groupTasks,
  INVESTIGATION_STATUS_LABELS,
  ISSUE_SOURCE_LABELS,
  STATUS_LABELS,
  STATUSES,
  unmetDependencies,
  type CombinedBranchDetail,
  type BaselineReport,
  type Investigation,
  type InvestigationDetail as InvestigationDetailModel,
  type IssueDetail as IssueDetailModel,
  type IssueState,
  type IssueSummary,
  type Note,
  type NoteSummary,
  type NotesWorkspaceInfo,
  type Priority,
  type Status,
  type Task,
  type TaskDetail as TaskDetailModel,
  type TaskGroup,
  type TaskGroupDetail,
  type TaskGroupSummary,
} from "@shared/types"
import type { ChangeChannel } from "@shared/types"
import { api, type Meta } from "./api"
import BranchDetail from "./components/BranchDetail.vue"
import GroupDetail from "./components/GroupDetail.vue"
import BaselineDetail from "./components/BaselineDetail.vue"
import CombineBranches from "./components/CombineBranches.vue"
import InvestigationDetail from "./components/InvestigationDetail.vue"
import IssueCards from "./components/IssueCards.vue"
import IssueDetail from "./components/IssueDetail.vue"
import NoteDetail from "./components/NoteDetail.vue"
import TaskDetail from "./components/TaskDetail.vue"
import TaskSchedule from "./components/TaskSchedule.vue"
import { useLiveUpdates } from "./useLiveUpdates"
import { useLocation } from "./useLocation"

/** Which rail section is showing. */
type View =
  | "investigations"
  | "tasks"
  | "plan"
  | "branches"
  | "baselines"
  | "combine"
  | "notes"
  | "issues"

const tasks = ref<Task[]>([])
const selected = ref<TaskDetailModel | null>(null)
const meta = ref<Meta | null>(null)
const filter = ref<Status | "all">("all")
const error = ref<string | null>(null)
/** The counterpart to `error` for actions whose success is worth stating —
 *  a sync that found nothing new has no other way to show it did anything.
 *  Unlike an error it clears itself: nothing is waiting on it being read. */
const notice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined

function showNotice(text: string): void {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = null
  }, 6000)
}
const loading = ref(true)
const creating = ref(false)
const selectedRefs = ref(new Set<string>())
const combining = ref(false)
const combineBranchName = ref("")
const closeCombinedTasks = ref(true)

const { location, navigate } = useLocation()
const view = ref<View>("tasks")

const VIEW_PATHS: Record<View, string> = {
  investigations: "/investigations",
  tasks: "/tasks",
  plan: "/plan",
  branches: "/branches",
  baselines: "/baselines",
  combine: "/combine",
  notes: "/notes",
  issues: "/issues",
}

/** `/groups/G-1` is a task-view route: the list stays on the left and the group
 *  takes the detail pane, the same shape as selecting a task. */
const GROUP_PATH = /^\/groups\/(.+)$/

function viewForPath(path: string): View {
  if (GROUP_PATH.test(path)) return "tasks"
  return (
    (Object.entries(VIEW_PATHS).find(([, value]) => value === path)?.[0] as
      View | undefined) ?? "tasks"
  )
}

/** The views drawn as one full-width page, with no list column beside them.
 *  Kept next to the sidebar's own condition so the two cannot drift apart —
 *  a view missing from here renders into the narrow list column instead. */
const FULL_WIDTH_PATHS = ["/plan", "/baselines"]
const fullWidth = computed(() => FULL_WIDTH_PATHS.includes(location.value))

/** True for the routes the task list is the sidebar of. */
const onTaskRoutes = computed(
  () => location.value === VIEW_PATHS.tasks || GROUP_PATH.test(location.value),
)

const investigations = ref<Investigation[]>([])
const selectedInvestigation = ref<InvestigationDetailModel | null>(null)
const investigationsLoading = ref(false)
const creatingInvestigation = ref(false)
const newInvestigation = ref({ title: "", brief: "" })

const notes = ref<NoteSummary[]>([])
const noteFolders = ref<string[]>([])
const noteTags = ref<string[]>([])
const notesWorkspace = ref<NotesWorkspaceInfo | null>(null)
const selectedNote = ref<Note | null>(null)
const notesLoading = ref(false)
const notesFilter = ref({ q: "", tag: "", folder: "" })
const creatingNote = ref(false)
const newNote = ref({ title: "", folder: "" })

const issues = ref<IssueSummary[]>([])
const issueFacets = ref<{
  sources: { source: string; count: number }[]
  labels: string[]
  total: number
}>({
  sources: [],
  labels: [],
  total: 0,
})
const selectedIssue = ref<IssueDetailModel | null>(null)
const issuesLoading = ref(false)
const issuesFilter = ref({
  q: "",
  state: "all" as IssueState | "all",
  source: "",
  label: "",
})

const branches = ref<CombinedBranchDetail[]>([])
const selectedBranch = ref<string | null>(null)
const branchesLoading = ref(false)

/** Investigations still waiting to be run — the only count worth a badge. */
const openInvestigations = computed(
  () => investigations.value.filter((one) => one.status !== "complete").length,
)

const currentBranch = computed(
  () =>
    branches.value.find(
      (branch) => branch.branchName === selectedBranch.value,
    ) ?? null,
)

const newTask = ref({
  title: "",
  description: "",
  priority: "medium" as Priority,
  tags: "",
  branchName: "",
  groupRef: "",
  estimateUnits: DEFAULT_ESTIMATE_UNITS,
})

const visibleTasks = computed(() =>
  filter.value === "all"
    ? tasks.value
    : tasks.value.filter((task) => task.status === filter.value),
)

/* ---------------------------------------------------------------- groups */

const groups = ref<TaskGroupSummary[]>([])
/** Whether the list is drawn in sections. A view preference, so it lives in the
 *  browser rather than the workspace — two people looking at the same tasks can
 *  disagree about this. */
const grouped = ref(localStorage.getItem("tasks.grouped") !== "off")
const collapsedGroups = ref(new Set<string>())
/** The group being created or renamed. `ref: null` means it does not exist yet. */
const groupDraft = ref<{
  ref: string | null
  name: string
  description: string
  color: string
  branchName: string
} | null>(null)

/** The branch name the server would derive, mirrored here so the field is
 *  filled in as the name is typed rather than appearing only after saving. Once
 *  the user edits the field it is theirs, and this stops writing to it. */
const groupBranchTouched = ref(false)

watch(
  () => groupDraft.value?.name,
  (name) => {
    const draft = groupDraft.value
    // Only while creating: renaming an existing group must not silently
    // repoint it at a branch its finished work is not on.
    if (!draft || draft.ref || groupBranchTouched.value) return
    const slug = (name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
    draft.branchName = slug ? `group/${slug}` : ""
  },
)
const groupBusy = ref(false)

watch(grouped, (on) => localStorage.setItem("tasks.grouped", on ? "on" : "off"))

/**
 * The list as it is drawn: sections when grouping is on, one nameless section
 * when it is off. Both shapes are the same so the template has one path.
 */
const sections = computed(() => {
  if (!grouped.value) return [{ group: null, items: visibleTasks.value }]

  const all = groupTasks(visibleTasks.value, groups.value, (task) => task)
  // An empty group is worth a heading in the full list — it is somewhere to drop
  // work. Under a status filter it is not: every group the filter emptied would
  // claim to be empty, which is a statement about the filter, not the group.
  return filter.value === "all"
    ? all
    : all.filter((section) => section.items.length)
})

/**
 * Every listed task in the order the sections put them — including the rows a
 * collapsed group is hiding.
 *
 * This, not `visibleTasks`, is what a drag reorders against: the drop lands
 * between two rows *as sectioned*, and pushing that order back is what makes a
 * group's tasks contiguous in the queue. Collapsed rows stay in it so folding a
 * group away cannot scatter the tasks inside it.
 */
const listedTasks = computed(() =>
  sections.value.flatMap((section) => section.items),
)

const groupOf = computed(() => {
  const index = new Map<string, TaskGroupSummary>()
  for (const group of groups.value) index.set(group.ref.toLowerCase(), group)
  return index
})

/** The group a task is drawn under, or null when it is loose. Resolved through
 *  the loaded groups so a ref pointing at a deleted one reads as loose. */
function groupFor(task: Task): TaskGroupSummary | null {
  return task.groupRef
    ? (groupOf.value.get(task.groupRef.toLowerCase()) ?? null)
    : null
}

function toggleCollapsed(ref_: string): void {
  const next = new Set(collapsedGroups.value)
  if (next.has(ref_)) next.delete(ref_)
  else next.add(ref_)
  collapsedGroups.value = next
}

/**
 * The last aio-vr baseline run. Read on entering the view rather than up front:
 * it is a file on disk that aio-vr rewrites, and nobody wants a stale tally.
 */
const baselines = ref<BaselineReport | null>(null)
const baselinesLoading = ref(false)

async function refreshBaselines(): Promise<void> {
  baselines.value = await api.baselines()
}

/** What the rail badges: scenarios that differ from their baseline or could not
 *  be captured. Unchanged ones are not news. */
const driftedCount = computed(
  () =>
    baselines.value?.scenarios.filter(
      (one) => one.status === "changed" || one.status === "failed",
    ).length ?? 0,
)

/** The group whose page is open, when the route is a group route. */
const selectedGroup = ref<TaskGroupDetail | null>(null)

/**
 * Open a group's page. The task list stays where it is — a group page is a
 * detail pane like a task's, not a different section of the app — but the task
 * selection is cleared, because only one thing can be in that pane.
 */
async function openGroup(ref_: string): Promise<void> {
  navigate(`/groups/${encodeURIComponent(ref_)}`)
  view.value = "tasks"
  selected.value = null
  error.value = null
  try {
    const group = await api.getGroup(ref_)
    // A server started before this page existed answers with the bare group and
    // no Git state. Say that, rather than letting the page fault on the first
    // field it reads — the fix is a restart, and nothing else will say so.
    if (!group?.git) {
      throw new Error(
        `This server predates the group page, so it cannot report ${ref_}'s branch. ` +
          "Restart `tasks web` and reload.",
      )
    }
    selectedGroup.value = group
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    selectedGroup.value = null
  }
}

/** A group page edits the group, so the sidebar's copy of it is refreshed too. */
async function onGroupChanged(group: TaskGroupDetail): Promise<void> {
  selectedGroup.value = group
  groups.value = await api.listGroups()
  await refreshList()
}

async function onGroupDeleted(ref_: string): Promise<void> {
  selectedGroup.value = null
  navigate(VIEW_PATHS.tasks)
  groups.value = groups.value.filter((one) => one.ref !== ref_)
  await refreshList()
}

function newGroup(): void {
  groupBranchTouched.value = false
  groupDraft.value = {
    ref: null,
    name: "",
    description: "",
    // Offered rather than imposed: the server picks the next unused colour when
    // none is sent, and an empty string is how this says "you choose".
    color: "",
    // Same again for the branch: empty means "derive it from the name and ref",
    // which the server can do properly because it knows the ref.
    branchName: "",
  }
}

/** Takes the plain group rather than the summary: the sections hand back what
 *  `groupTasks` put in them, and the counts are not what is being edited. */
function editGroup(group: TaskGroup): void {
  groupBranchTouched.value = true
  groupDraft.value = {
    ref: group.ref,
    name: group.name,
    description: group.description,
    color: group.color,
    branchName: group.branchName,
  }
}

async function saveGroup(): Promise<void> {
  const draft = groupDraft.value
  if (!draft?.name.trim()) return

  groupBusy.value = true
  error.value = null
  try {
    if (draft.ref) {
      const result = await api.updateGroup(draft.ref, {
        name: draft.name,
        description: draft.description,
        color: draft.color || undefined,
        branchName: draft.branchName.trim() || undefined,
      })
      groups.value = result.groups
      tasks.value = result.tasks
    } else {
      const result = await api.createGroup({
        name: draft.name,
        description: draft.description,
        color: draft.color || undefined,
        branchName: draft.branchName.trim() || undefined,
      })
      groups.value = result.groups
      grouped.value = true
    }
    groupDraft.value = null
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    groupBusy.value = false
  }
}

/** Deleting a group keeps its tasks — which is the whole reassurance the
 *  confirmation needs, so it says so and names how many. */
async function removeGroup(ref_: string): Promise<void> {
  const group = groups.value.find((one) => one.ref === ref_)
  if (!group) return

  const kept = group.taskCount
    ? `Its ${group.taskCount} task(s) are kept and become ungrouped.`
    : "It is empty."
  if (!confirm(`Delete the group '${group.name}'? ${kept}`)) return

  groupBusy.value = true
  error.value = null
  try {
    const result = await api.deleteGroup(group.ref)
    groups.value = result.groups
    tasks.value = result.tasks
    groupDraft.value = null
    if (result.released.length) {
      showNotice(
        `'${group.name}' deleted. ${result.released.length} task(s) are now ungrouped.`,
      )
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    groupBusy.value = false
  }
}

/**
 * Group the checked rows in one go — the way to file a batch without dragging
 * each one, and the only way to do it at all from the keyboard.
 *
 * One request per task rather than a bulk endpoint: each assignment also moves
 * the task beside the rest of its new group, and doing that in sequence is what
 * keeps the batch landing in the order it was listed in.
 */
async function assignGroupToSelection(choice: string): Promise<void> {
  if (!choice) return
  const groupRef = choice === "none" ? null : choice

  const refs = visibleTasks.value
    .filter((task) => selectedRefs.value.has(task.ref))
    .map((task) => task.ref)
  if (!refs.length) return

  error.value = null
  try {
    for (const ref_ of refs) {
      const result = await api.setTaskGroup(ref_, groupRef)
      tasks.value = result.tasks
      groups.value = result.groups
      if (selected.value?.ref === ref_) selected.value = result.task
    }
    const name = groupRef
      ? groups.value.find((one) => one.ref === groupRef)?.name
      : null
    showNotice(
      name
        ? `${refs.length} task(s) moved into '${name}'.`
        : `${refs.length} task(s) ungrouped.`,
    )
    selectedRefs.value = new Set()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    await refreshList()
  }
}

/** For each task still waiting on something, the refs it waits on. Computed
 *  over the whole list rather than the filtered one, so a blocker hidden by the
 *  status filter still counts. */
const blockedBy = computed(() => {
  const map = new Map<string, string[]>()
  for (const task of tasks.value) {
    const waiting = unmetDependencies(task, tasks.value)
    if (waiting.length)
      map.set(
        task.ref,
        waiting.map((one) => one.ref),
      )
  }
  return map
})

const counts = computed(() => {
  const result: Record<string, number> = { all: tasks.value.length }
  for (const status of STATUSES) {
    result[status] = tasks.value.filter((task) => task.status === status).length
  }
  return result
})

async function refreshList(): Promise<void> {
  // The two are read together everywhere: a task's section cannot be drawn from
  // the task alone, and a group's counts move whenever the tasks do.
  const [nextTasks, nextGroups] = await Promise.all([
    api.listTasks(),
    api.listGroups(),
  ])
  tasks.value = nextTasks
  groups.value = nextGroups
}

async function select(ref_: string): Promise<void> {
  error.value = null
  // The detail pane holds one thing. Picking a task from the list while a group
  // page is open means the task, so leave the group route rather than selecting
  // something the pane will not show.
  if (selectedGroup.value) {
    selectedGroup.value = null
    navigate(VIEW_PATHS.tasks)
  }
  try {
    selected.value = await api.getTask(ref_)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

/** A detail-pane mutation changed the task; keep the list column in step. */
async function onChanged(task: TaskDetailModel): Promise<void> {
  selected.value = task
  await refreshList()
}

async function onDeleted(ref_: string): Promise<void> {
  selected.value = null
  tasks.value = tasks.value.filter((task) => task.ref !== ref_)
}

function toggleTask(ref_: string): void {
  const next = new Set(selectedRefs.value)
  if (next.has(ref_)) next.delete(ref_)
  else next.add(ref_)
  selectedRefs.value = next
}

/* ------------------------------------------------------------ list order */

/** The row being dragged, and the row the pointer is currently over. */
const draggingRef = ref<string | null>(null)
const dropTargetRef = ref<string | null>(null)
/** Whether the drop lands below the target row rather than above it. */
const dropBelow = ref(false)
/** The group header the pointer is over, when the drop would land on one.
 *  `''` is the ungrouped section, which is a real target: it is how a task is
 *  taken out of a group. */
const dropGroupRef = ref<string | null>(null)

/**
 * Push a new order for the visible rows.
 *
 * Only the visible rows move: their new sequence is threaded back through the
 * full list in place, leaving rows the filter hides exactly where they are.
 * That mirrors what the server does with the positions, so the optimistic
 * update and the reload agree.
 */
async function applyOrder(orderedVisibleRefs: string[]): Promise<void> {
  const moving = new Set(orderedVisibleRefs)
  const byRef = new Map(tasks.value.map((task) => [task.ref, task]))
  let next = 0

  tasks.value = tasks.value.map((task) =>
    moving.has(task.ref) ? byRef.get(orderedVisibleRefs[next++]!)! : task,
  )

  try {
    tasks.value = await api.reorderTasks(orderedVisibleRefs)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    await refreshList()
  }
}

/**
 * Move one row `delta` places within the list as it is drawn.
 *
 * Crossing a section boundary moves the task into that section's group, because
 * that is what the row's new surroundings say it is now — the keyboard does the
 * same thing the drag does.
 */
async function moveBy(ref_: string, delta: number): Promise<void> {
  const rows = listedTasks.value
  const order = rows.map((task) => task.ref)
  const from = order.indexOf(ref_)
  const to = from + delta
  if (from === -1 || to < 0 || to >= order.length) return

  const landing = rows[to]!
  const moved = rows[from]!
  order.splice(to, 0, ...order.splice(from, 1))

  if (
    grouped.value &&
    (landing.groupRef ?? null) !== (moved.groupRef ?? null)
  ) {
    if (!(await regroup(moved.ref, landing.groupRef ?? null))) return
  }
  await applyOrder(order)
}

/**
 * Change a dragged or nudged row's group without letting the server also decide
 * where it goes — the gesture already did that, and `applyOrder` is about to
 * send it. Returns false when the change failed, so the caller can leave the
 * order alone rather than reorder rows into a group they did not join.
 */
async function regroup(
  ref_: string,
  groupRef: string | null,
): Promise<boolean> {
  try {
    const result = await api.setTaskGroup(ref_, groupRef, false)
    // Only the membership is taken from the response: the order is still the
    // optimistic one on screen, and `applyOrder` writes it a moment later.
    const moved = result.tasks.find((task) => task.ref === ref_)
    tasks.value = tasks.value.map((task) =>
      task.ref === ref_ && moved ? { ...task, groupRef: moved.groupRef } : task,
    )
    groups.value = result.groups
    if (selected.value?.ref === ref_) selected.value = result.task
    return true
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    await refreshList()
    return false
  }
}

function onDragStart(ref_: string, event: DragEvent): void {
  draggingRef.value = ref_
  event.dataTransfer?.setData("text/plain", ref_)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
}

function onDragOver(ref_: string, event: DragEvent): void {
  if (!draggingRef.value || draggingRef.value === ref_) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"

  // Which half of the row the pointer is in decides whether the dragged task
  // lands above or below it — without that, dropping onto the last row can
  // never reach the bottom of the list.
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropTargetRef.value = ref_
  dropGroupRef.value = null
  dropBelow.value = event.clientY > box.top + box.height / 2
}

/* ------------------------------------------------- dragging into a group */

/**
 * Hovering a section heading. The heading is a drop target in its own right so
 * a group can be joined without aiming between two rows — and so an *empty*
 * group can be dropped into at all.
 */
function onGroupDragOver(groupRef: string, event: DragEvent): void {
  if (!draggingRef.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  dropGroupRef.value = groupRef
  dropTargetRef.value = null
}

function onGroupDragLeave(groupRef: string, event: DragEvent): void {
  const heading = event.currentTarget as HTMLElement
  const entering = event.relatedTarget as Node | null
  if (entering && heading.contains(entering)) return
  if (dropGroupRef.value === groupRef) dropGroupRef.value = null
}

/** Dropping onto a heading puts the task at the top of that section. */
async function onGroupDrop(groupRef: string): Promise<void> {
  const moved = draggingRef.value
  endDrag()
  if (!moved) return

  const target = groupRef || null
  const task = tasks.value.find((one) => one.ref === moved)
  if (!task) return

  const order = listedTasks.value.map((one) => one.ref)
  const from = order.indexOf(moved)
  if (from === -1) return
  order.splice(from, 1)

  // Where the section starts, once the dragged row is out of the way. An empty
  // group has no first row, so the task simply keeps its place in the queue and
  // only its membership changes.
  const first = listedTasks.value.find(
    (one) => one.ref !== moved && (one.groupRef ?? "") === (target ?? ""),
  )

  if ((task.groupRef ?? null) !== target) {
    if (!(await regroup(moved, target))) return
  }
  if (!first) return

  order.splice(order.indexOf(first.ref), 0, moved)
  await applyOrder(order)
}

/** `dragleave` also fires when the pointer crosses onto one of the row's own
 *  children, which would blink the insertion marker off on every word it passes
 *  over. Only a leave that lands outside the row is a real leave. */
function onDragLeave(ref_: string, event: DragEvent): void {
  const row = event.currentTarget as HTMLElement
  const entering = event.relatedTarget as Node | null
  if (entering && row.contains(entering)) return
  if (dropTargetRef.value === ref_) dropTargetRef.value = null
}

async function onDrop(ref_: string): Promise<void> {
  const moved = draggingRef.value
  const below = dropBelow.value
  endDrag()
  if (!moved || moved === ref_) return

  const rows = listedTasks.value
  const order = rows.map((task) => task.ref)
  const from = order.indexOf(moved)
  if (from === -1) return

  // Dropping onto a row is also how a task joins that row's group: the section
  // it lands in is the group it is now in, which is the only reading of the
  // gesture that matches what the list shows afterwards.
  const target = rows.find((task) => task.ref === ref_)
  const dragged = rows.find((task) => task.ref === moved)
  if (
    grouped.value &&
    target &&
    dragged &&
    (target.groupRef ?? null) !== (dragged.groupRef ?? null)
  ) {
    if (!(await regroup(moved, target.groupRef ?? null))) return
  }

  order.splice(from, 1)
  const anchor = order.indexOf(ref_)
  order.splice(anchor + (below ? 1 : 0), 0, moved)
  await applyOrder(order)
}

function endDrag(): void {
  draggingRef.value = null
  dropTargetRef.value = null
  dropGroupRef.value = null
}

/* --------------------------------------------------------- investigations */

async function refreshInvestigations(): Promise<void> {
  investigations.value = await api.listInvestigations()
}

async function selectInvestigation(ref_: string): Promise<void> {
  error.value = null
  try {
    selectedInvestigation.value = await api.getInvestigation(ref_)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function onInvestigationChanged(
  investigation: InvestigationDetailModel,
): Promise<void> {
  selectedInvestigation.value = investigation
  await refreshInvestigations()
}

async function onInvestigationDeleted(ref_: string): Promise<void> {
  selectedInvestigation.value = null
  investigations.value = investigations.value.filter((one) => one.ref !== ref_)
  // Tasks it filed survive the delete, but their link is gone.
  await refreshList()
}

async function createInvestigation(): Promise<void> {
  if (!newInvestigation.value.title.trim()) return

  try {
    const created = await api.createInvestigation({
      title: newInvestigation.value.title,
      brief: newInvestigation.value.brief,
    })

    creatingInvestigation.value = false
    newInvestigation.value = { title: "", brief: "" }
    await refreshInvestigations()
    selectedInvestigation.value = created
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

/** Jump from a task back to the investigation that filed it. */
async function openInvestigation(ref_: string): Promise<void> {
  navigate(VIEW_PATHS.investigations)
  view.value = "investigations"
  await refreshInvestigations()
  await selectInvestigation(ref_)
}

/* ----------------------------------------------------------------- notes */

/**
 * Notes come off the file system, not the database, so the list is re-read
 * rather than patched: the folder is a Git repository somebody may have pulled,
 * edited in another editor or written to with `tasks notes` since this tab was
 * opened, and there is no event to tell us they did.
 */
async function refreshNotes(): Promise<void> {
  const listing = await api.listNotes({
    q: notesFilter.value.q || undefined,
    tag: notesFilter.value.tag || undefined,
    folder: notesFilter.value.folder || undefined,
  })
  notes.value = listing.notes
  noteFolders.value = listing.folders
  noteTags.value = listing.tags
  notesWorkspace.value = listing.workspace
}

async function selectNote(path: string): Promise<void> {
  error.value = null
  try {
    selectedNote.value = await api.getNote(path)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

/** A saved note can have changed its title, tags or modified time, all of which
 *  the list column shows — and its Git state moves with every write. */
async function onNoteChanged(note: Note): Promise<void> {
  selectedNote.value = note
  await refreshNotes()
}

async function onNoteDeleted(path: string): Promise<void> {
  selectedNote.value = null
  notes.value = notes.value.filter((note) => note.path !== path)
  await refreshNotes()
  if (notes.value.length) await selectNote(notes.value[0]!.path)
}

async function createNote(): Promise<void> {
  if (!newNote.value.title.trim()) return

  try {
    const created = await api.createNote({
      title: newNote.value.title,
      folder: newNote.value.folder.trim() || undefined,
    })
    creatingNote.value = false
    newNote.value = { title: "", folder: "" }
    await refreshNotes()
    selectedNote.value = created
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function syncNotes(push: boolean): Promise<void> {
  notesLoading.value = true
  error.value = null
  try {
    await api.syncNotes(push)
    await refreshNotes()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    notesLoading.value = false
  }
}

/**
 * Fetch and fast-forward the notes repository, then reload whichever of the two
 * views it backs is on screen. Notes and Issues are the same folder, so this is
 * the same button in both places.
 */
async function pullNotes(): Promise<void> {
  notesLoading.value = true
  issuesLoading.value = true
  error.value = null
  notice.value = null
  try {
    const result = await api.pullNotes()
    notesWorkspace.value = result.workspace
    showNotice(
      result.received
        ? `Pulled ${result.received} commit(s) from ${result.upstream}.`
        : result.upstream
          ? `Already up to date with ${result.upstream}.${result.unpushed ? ` ${result.unpushed} local commit(s) not pushed.` : ""}`
          : "Fetched — this branch is not on the remote yet.",
    )
    await Promise.all([
      view.value === "notes" ? refreshNotes() : Promise.resolve(),
      view.value === "issues" ? refreshIssues() : Promise.resolve(),
    ])
    if (selectedNote.value)
      selectedNote.value = await reload(() =>
        api.getNote(selectedNote.value!.path),
      )
    if (selectedIssue.value)
      selectedIssue.value = await reload(() =>
        api.getIssue(selectedIssue.value!.id),
      )
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    notesLoading.value = false
    issuesLoading.value = false
  }
}

/** Creates the folder and `git init`s it — the one action available when the
 *  configured notes folder is not there yet. */
async function initNotes(): Promise<void> {
  notesLoading.value = true
  error.value = null
  try {
    notesWorkspace.value = await api.initNotes()
    await refreshNotes()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    notesLoading.value = false
  }
}

let notesSearchTimer: ReturnType<typeof setTimeout> | undefined

/** Search runs on the server (it reads the files), so it is debounced rather
 *  than fired on every keystroke. */
watch(
  () => ({ ...notesFilter.value }),
  () => {
    clearTimeout(notesSearchTimer)
    notesSearchTimer = setTimeout(() => {
      void refreshNotes().catch((caught: unknown) => {
        error.value = caught instanceof Error ? caught.message : String(caught)
      })
    }, 200)
  },
  { deep: true },
)

/* ---------------------------------------------------------------- issues */

/**
 * Issues are JSON files in the notes folder, fetched by something else — so
 * like notes they are re-read rather than cached, and there is nothing here
 * that writes back.
 */
async function refreshIssues(): Promise<void> {
  const listing = await api.listIssues({
    q: issuesFilter.value.q || undefined,
    state:
      issuesFilter.value.state === "all" ? undefined : issuesFilter.value.state,
    source: issuesFilter.value.source || undefined,
    label: issuesFilter.value.label || undefined,
  })
  issues.value = listing.issues
  issueFacets.value = listing.facets
  notesWorkspace.value = listing.notes
}

async function openIssue(id: string): Promise<void> {
  error.value = null
  try {
    selectedIssue.value = await api.getIssue(id)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

const issuesFiltered = computed(
  () =>
    Boolean(
      issuesFilter.value.q ||
      issuesFilter.value.source ||
      issuesFilter.value.label,
    ) || issuesFilter.value.state !== "all",
)

let issuesSearchTimer: ReturnType<typeof setTimeout> | undefined

watch(
  () => ({ ...issuesFilter.value }),
  () => {
    clearTimeout(issuesSearchTimer)
    issuesSearchTimer = setTimeout(() => {
      void refreshIssues().catch((caught: unknown) => {
        error.value = caught instanceof Error ? caught.message : String(caught)
      })
    }, 200)
  },
  { deep: true },
)

/* -------------------------------------------------------------- branches */

async function refreshBranches(): Promise<void> {
  branchesLoading.value = true
  try {
    const result = await api.listBranches()
    branches.value = result.branches
    if (
      !branches.value.some(
        (branch) => branch.branchName === selectedBranch.value,
      )
    ) {
      selectedBranch.value = branches.value[0]?.branchName ?? null
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    branchesLoading.value = false
  }
}

/** Splice the server's version of one branch back into the list, leaving the
 *  other rows (each carrying a fresh Git read) untouched. */
function onBranchChanged(branch: CombinedBranchDetail): void {
  branches.value = branches.value.map((existing) =>
    existing.branchName === branch.branchName ? branch : existing,
  )
  selectedBranch.value = branch.branchName
}

function onBranchForgotten(name: string): void {
  branches.value = branches.value.filter((branch) => branch.branchName !== name)
  selectedBranch.value = branches.value[0]?.branchName ?? null
}

async function showView(next: View): Promise<void> {
  view.value = next
  error.value = null
  // Git state is read per request, so a revisit always reflects the working
  // tree as it is now rather than as it was when the tab was last open.
  if (next === "branches") await refreshBranches()

  // aio-vr rewrites its results file from the terminal as often as from here,
  // so every visit re-reads it rather than trusting what was last drawn.
  if (next === "baselines") {
    baselinesLoading.value = true
    try {
      await refreshBaselines()
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      baselinesLoading.value = false
    }
  }

  // The plan is a read of the whole task list — estimates and dependencies
  // included — and the CLI and agents write to it between visits.
  if (next === "plan") await refreshList()

  // The issue files are refreshed by whatever fetches them, so every visit is a
  // fresh read — and the board opens on the board, not on whatever was last
  // clicked into.
  if (next === "issues") {
    issuesLoading.value = true
    selectedIssue.value = null
    try {
      await refreshIssues()
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      issuesLoading.value = false
    }
  }

  // Same reasoning for notes, which live on disk and change behind this tab's
  // back whenever the CLI, an agent or a `git pull` touches the folder.
  if (next === "notes") {
    notesLoading.value = true
    try {
      await refreshNotes()
      const previous = selectedNote.value?.path
      const current = notes.value.some((note) => note.path === previous)
        ? previous
        : notes.value[0]?.path
      if (current) await selectNote(current)
      else selectedNote.value = null
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      notesLoading.value = false
    }
  }

  // An agent may have run an investigation since this tab was last open, so
  // re-read rather than trusting what is on screen.
  if (next === "investigations") {
    investigationsLoading.value = true
    try {
      await refreshInvestigations()
      const previous = selectedInvestigation.value?.ref
      const current = investigations.value.some((one) => one.ref === previous)
        ? previous
        : investigations.value[0]?.ref
      if (current) await selectInvestigation(current)
      else selectedInvestigation.value = null
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught)
    } finally {
      investigationsLoading.value = false
    }
  }
}

/** Jump from a branch's or a group's task chip back to that task. */
async function openTask(ref_: string): Promise<void> {
  navigate(VIEW_PATHS.tasks)
  view.value = "tasks"
  selectedGroup.value = null
  await select(ref_)
}

function navigateTo(next: View): void {
  navigate(VIEW_PATHS[next])
  void showView(next)
}

function combineSelected(): void {
  if (selectedRefs.value.size < 1) return
  error.value = null
  navigateTo("combine")
}

/** Jump from a group's page to that branch in the Branches view, which is where
 *  the PR is written and opened. */
async function openBranch(branchName: string): Promise<void> {
  selectedGroup.value = null
  selectedBranch.value = branchName
  navigate(VIEW_PATHS.branches)
  await showView("branches")
  selectedBranch.value = branchName
}

async function combineStarted(branchName: string): Promise<void> {
  selectedRefs.value = new Set()
  combineBranchName.value = ""
  closeCombinedTasks.value = true
  selectedBranch.value = branchName
  await refreshList()
  navigate(VIEW_PATHS.branches)
  await showView("branches")
}

async function continueCombine(branchName: string): Promise<void> {
  combining.value = true
  error.value = null
  try {
    await api.continueCombine(branchName)
    await refreshList()
    await refreshBranches()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    await refreshBranches()
  } finally {
    combining.value = false
  }
}

async function createTask(): Promise<void> {
  if (!newTask.value.title.trim()) return

  try {
    const created = await api.createTask({
      title: newTask.value.title,
      description: newTask.value.description,
      priority: newTask.value.priority,
      tags: newTask.value.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      branchName: newTask.value.branchName.trim() || undefined,
      groupRef: newTask.value.groupRef || null,
      estimateUnits: newTask.value.estimateUnits,
    })

    creating.value = false
    newTask.value = {
      title: "",
      description: "",
      priority: "medium",
      tags: "",
      branchName: "",
      groupRef: "",
      estimateUnits: DEFAULT_ESTIMATE_UNITS,
    }
    await refreshList()
    await select(created.ref)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

/* ---------------------------------------------------------- live updates */

/**
 * Something else wrote to the workspace — the CLI, an agent, a `git pull`.
 *
 * Reloads what is actually on screen rather than everything: the two list
 * columns that are visible from anywhere, whatever record is selected, and the
 * current view's own data. The detail components each keep unsaved typing over
 * an incoming version (see the brief, the note body and the PR description), so
 * this cannot take an edit out from under anyone.
 */
async function refreshFromChange(channel: ChangeChannel): Promise<void> {
  // A drag is a reorder the server has not been told about yet; reloading the
  // list underneath it would put every row back where it started.
  if (draggingRef.value) return

  try {
    if (channel === "tasks") {
      await Promise.all([refreshList(), refreshInvestigations()])
      if (selected.value)
        selected.value = await reload(() => api.getTask(selected.value!.ref))
      // A group page shows live Git state, so a change anywhere is a reason to
      // re-read it — an agent working the group moves both at once.
      if (selectedGroup.value) {
        selectedGroup.value = await reload(() =>
          api.getGroup(selectedGroup.value!.ref),
        )
      }
      if (selectedInvestigation.value) {
        selectedInvestigation.value = await reload(() =>
          api.getInvestigation(selectedInvestigation.value!.ref),
        )
      }
      if (view.value === "branches") await refreshBranches()
      return
    }

    if (view.value === "notes") {
      await refreshNotes()
      if (selectedNote.value)
        selectedNote.value = await reload(() =>
          api.getNote(selectedNote.value!.path),
        )
    }

    if (view.value === "issues") {
      await refreshIssues()
      if (selectedIssue.value)
        selectedIssue.value = await reload(() =>
          api.getIssue(selectedIssue.value!.id),
        )
    }
  } catch {
    // A background refresh that fails is not worth a toast: the screen keeps
    // what it had, and the next change — or any click — tries again.
  }
}

/** Reload one selected record. Something deleted elsewhere simply deselects
 *  rather than leaving an error over a screen the user did not touch. */
async function reload<T>(fetch_: () => Promise<T>): Promise<T | null> {
  try {
    return await fetch_()
  } catch {
    return null
  }
}

const { connected: liveConnected, unavailable: liveUnavailable } =
  useLiveUpdates((channel) => void refreshFromChange(channel))

watch(location, (path) => {
  const next = viewForPath(path)
  // A group route is a real route rather than a typo to be corrected, and Back
  // out of one lands on the task list without a group selected.
  const groupRef = GROUP_PATH.exec(path)?.[1]
  if (groupRef) {
    if (
      selectedGroup.value?.ref.toLowerCase() !==
      decodeURIComponent(groupRef).toLowerCase()
    ) {
      void openGroup(decodeURIComponent(groupRef))
    }
    return
  }
  selectedGroup.value = null

  if (path !== VIEW_PATHS[next]) {
    window.history.replaceState({}, "", VIEW_PATHS[next])
    location.value = VIEW_PATHS[next]
    return
  }
  if (next !== view.value) void showView(next)
})

onMounted(async () => {
  try {
    // The rail's investigation count is visible from every view, so the list is
    // loaded up front even though Tasks is what opens first. The drift badge is
    // the same argument: a badge that only appears once you have visited the
    // view cannot be what tells you to visit it.
    ;[meta.value] = await Promise.all([
      api.meta(),
      refreshList(),
      refreshInvestigations(),
      // Never fatal. A repository with no aio-vr workspace is perfectly normal,
      // and it must not stop the app from opening.
      refreshBaselines().catch(() => undefined),
    ])
    if (tasks.value.length) await select(tasks.value[0]!.ref)
    const initialView = viewForPath(location.value)
    // A group page is linkable, so opening one directly has to restore it
    // rather than being normalised away to the bare task list.
    const initialGroup = GROUP_PATH.exec(location.value)?.[1]
    if (initialGroup) {
      await openGroup(decodeURIComponent(initialGroup))
    } else {
      if (location.value !== VIEW_PATHS[initialView]) {
        window.history.replaceState({}, "", VIEW_PATHS[initialView])
        location.value = VIEW_PATHS[initialView]
      }
      await showView(initialView)
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <!-- `full` drops the sidebar column. Both views that use it are whole pages
       rather than a list plus a detail: a chart, and a wall of screenshots. -->
  <div class="app" :class="{ full: fullWidth }">
    <!-- ------------------------------------------------------------- rail -->
    <nav class="rail" aria-label="Sections">
      <button
        class="rail-item"
        :class="{ active: location === '/investigations' }"
        title="Investigations"
        aria-label="Investigations"
        :aria-current="location === '/investigations'"
        @click="navigateTo('investigations')"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5L21 21" />
        </svg>
        <span v-if="openInvestigations" class="rail-count">{{
          openInvestigations
        }}</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/tasks' }"
        title="Tasks"
        aria-label="Tasks"
        :aria-current="location === '/tasks'"
        @click="navigateTo('tasks')"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/plan' }"
        title="Plan"
        aria-label="Plan"
        :aria-current="location === '/plan'"
        @click="navigateTo('plan')"
      >
        <!-- Stacked bars, staggered: the shape of the chart it opens. -->
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6h9" />
          <path d="M8 12h11" />
          <path d="M6 18h7" />
        </svg>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/branches' }"
        title="Branches"
        aria-label="Branches"
        :aria-current="location === '/branches'"
        @click="navigateTo('branches')"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="5" r="2.5" />
          <circle cx="6" cy="19" r="2.5" />
          <circle cx="18" cy="12" r="2.5" />
          <path d="M6 7.5v9" />
          <path d="M15.5 12H12a6 6 0 0 1-6-6" />
        </svg>
        <span v-if="branches.length" class="rail-count">{{
          branches.length
        }}</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/baselines' }"
        title="Baselines"
        aria-label="Baselines"
        :aria-current="location === '/baselines'"
        @click="navigateTo('baselines')"
      >
        <!-- Two overlaid frames with a gap between them: one image measured
             against another, which is the whole idea. -->
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="11" height="11" rx="1.5" />
          <path d="M10 19h10a1 1 0 0 0 1-1V9" />
          <path d="M6 11.5l2.5-2.5 3 3" />
        </svg>
        <!-- The count is the drift, not the suite: a number here means work. -->
        <span v-if="driftedCount" class="rail-count">{{ driftedCount }}</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/notes' }"
        title="Notes"
        aria-label="Notes"
        :aria-current="location === '/notes'"
        @click="navigateTo('notes')"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
          />
          <path d="M14 3v5h5" />
          <path d="M8 13h7M8 17h5" />
        </svg>
      </button>

      <button
        class="rail-item"
        :class="{ active: location === '/issues' }"
        title="Issues"
        aria-label="Issues"
        :aria-current="location === '/issues'"
        @click="navigateTo('issues')"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5" />
          <path d="M12 16.5v.01" />
        </svg>
        <span v-if="issueFacets.total" class="rail-count">{{
          issueFacets.total
        }}</span>
      </button>

      <!-- Only ever shown when live updates are *not* working. A page that
           quietly stopped following the workspace looks exactly like one where
           nothing has happened, which is the failure worth naming. -->
      <span
        v-if="!liveConnected"
        class="rail-live"
        :class="{ gone: liveUnavailable }"
        role="status"
        :title="
          liveUnavailable
            ? 'Live updates are unavailable — this server predates /api/events. Restart `tasks web` and reload; until then, changes made elsewhere appear when you switch views.'
            : 'Live updates disconnected — reconnecting. Changes made elsewhere may not be showing.'
        "
      >
        <span class="rail-live-dot" />
      </span>
    </nav>

    <!-- ----------------------------------------------- investigations list -->
    <aside v-if="location === '/investigations'" class="sidebar">
      <div class="sidebar-header">
        <h1>Investigations</h1>
        <div class="row">
          <p class="faint" style="margin: 0; flex: 1">
            Questions to look into. Run one to turn it into tasks.
          </p>
          <button class="primary" @click="creatingInvestigation = true">
            New
          </button>
        </div>
      </div>

      <div class="task-list">
        <button
          v-for="investigation in investigations"
          :key="investigation.ref"
          class="task-item"
          :class="{
            selected: selectedInvestigation?.ref === investigation.ref,
          }"
          @click="selectInvestigation(investigation.ref)"
        >
          <div class="row">
            <span class="mono faint">{{ investigation.ref }}</span>
            <span class="badge" :class="investigation.status">
              {{ INVESTIGATION_STATUS_LABELS[investigation.status] }}
            </span>
          </div>
          <div class="task-item-title">{{ investigation.title }}</div>
        </button>

        <p
          v-if="!investigationsLoading && !investigations.length"
          class="empty"
        >
          Nothing to investigate yet. Write the first question down.
        </p>
      </div>
    </aside>

    <!-- -------------------------------------------------------- tasks list -->
    <aside v-else-if="onTaskRoutes" class="sidebar">
      <div class="sidebar-header">
        <h1>Tasks</h1>
        <div class="row">
          <select v-model="filter" aria-label="Filter by status">
            <option value="all">All ({{ counts.all }})</option>
            <option v-for="status in STATUSES" :key="status" :value="status">
              {{ STATUS_LABELS[status] }} ({{ counts[status] }})
            </option>
          </select>
          <button class="primary" @click="creating = true">New</button>
        </div>
        <!-- Grouping is a way of reading this list, not a filter on it: every
             task is still here either way, and the queue order is unchanged. -->
        <div class="row" style="margin-top: 8px">
          <label class="group-switch">
            <input v-model="grouped" type="checkbox" />
            Group
          </label>
          <span class="spacer" />
          <button
            :disabled="groupBusy"
            title="Create a group and drag tasks into it"
            @click="newGroup"
          >
            New group
          </button>
        </div>
      </div>

      <div class="task-list">
        <template
          v-for="section in sections"
          :key="section.group?.ref ?? 'ungrouped'"
        >
          <!-- The heading is a drop target of its own, so joining a group does
               not mean aiming between two rows — and so an empty group can be
               dropped into at all. The ungrouped heading is how a task leaves
               a group the same way. -->
          <div
            v-if="grouped"
            class="group-head"
            :class="{
              'drop-into': dropGroupRef === (section.group?.ref ?? ''),
            }"
            @dragover="onGroupDragOver(section.group?.ref ?? '', $event)"
            @dragleave="onGroupDragLeave(section.group?.ref ?? '', $event)"
            @drop.prevent="onGroupDrop(section.group?.ref ?? '')"
          >
            <button
              class="group-toggle"
              :aria-expanded="!collapsedGroups.has(section.group?.ref ?? '')"
              :title="
                collapsedGroups.has(section.group?.ref ?? '')
                  ? 'Expand'
                  : 'Collapse'
              "
              @click="toggleCollapsed(section.group?.ref ?? '')"
            >
              {{ collapsedGroups.has(section.group?.ref ?? "") ? "▸" : "▾" }}
            </button>
            <span
              class="group-dot"
              :style="{
                background: section.group?.color ?? 'var(--text-faint)',
              }"
              aria-hidden="true"
            />
            <span class="group-name">{{
              section.group?.name ?? "Ungrouped"
            }}</span>
            <span class="faint">{{ section.items.length }}</span>
            <span
              v-if="section.group?.branchName"
              class="mono faint group-branch"
              :title="`These tasks are branched from, and merged back into, ${section.group.branchName}`"
            >
              {{ section.group.branchName }}
            </span>
            <span class="spacer" />
            <template v-if="section.group">
              <!-- The group's own page: its branch, its work order, and the
                   button that points an agent at the whole thing. -->
              <button
                class="group-action"
                :title="`Open ${section.group.ref}`"
                @click="openGroup(section.group.ref)"
              >
                Open
              </button>
              <button
                class="group-action"
                :title="`Rename, recolour or rebranch ${section.group.ref}`"
                @click="editGroup(section.group)"
              >
                Edit
              </button>
            </template>
          </div>

          <template v-if="!collapsedGroups.has(section.group?.ref ?? '')">
            <button
              v-for="task in section.items"
              :key="task.ref"
              class="task-item"
              :class="{
                selected: selected?.ref === task.ref,
                dragging: draggingRef === task.ref,
                'drop-above': dropTargetRef === task.ref && !dropBelow,
                'drop-below': dropTargetRef === task.ref && dropBelow,
                'in-group': grouped && !!section.group,
              }"
              :style="
                grouped && section.group
                  ? { '--group-color': section.group.color }
                  : undefined
              "
              draggable="true"
              :title="`${task.ref} — drag to reorder or into a group, or Alt+↑/↓`"
              @click="select(task.ref)"
              @dragstart="onDragStart(task.ref, $event)"
              @dragover="onDragOver(task.ref, $event)"
              @dragleave="onDragLeave(task.ref, $event)"
              @drop.prevent="onDrop(task.ref)"
              @dragend="endDrag"
              @keydown.alt.up.prevent="moveBy(task.ref, -1)"
              @keydown.alt.down.prevent="moveBy(task.ref, 1)"
            >
              <div class="row">
                <span class="drag-grip" aria-hidden="true">⠿</span>
                <input
                  class="task-select"
                  type="checkbox"
                  :checked="selectedRefs.has(task.ref)"
                  :aria-label="`Select ${task.ref}`"
                  @click.stop
                  @change="toggleTask(task.ref)"
                />
                <span class="mono faint">{{ task.ref }}</span>
                <span class="badge" :class="task.status">{{
                  STATUS_LABELS[task.status]
                }}</span>
                <span class="spacer" />
                <span
                  v-if="task.priority !== 'medium'"
                  :class="`priority-${task.priority}`"
                >
                  {{ task.priority === "high" ? "!" : "·" }}
                </span>
              </div>
              <div class="task-item-title">{{ task.title }}</div>
              <!-- Marked, not filtered or sorted: the order of this list is the
                   user's queue, and a blocked task at the top is information. -->
              <div v-if="blockedBy.get(task.ref)" class="blocked-note">
                ⊘ waiting on {{ blockedBy.get(task.ref)!.join(", ") }}
              </div>
              <div class="row">
                <!-- With sections off there is nothing else saying which group a
                     task is in, and that is exactly when it is worth a chip. -->
                <span
                  v-if="!grouped && groupFor(task)"
                  class="group-chip"
                  :style="{ '--group-color': groupFor(task)!.color }"
                >
                  {{ groupFor(task)!.name }}
                </span>
                <span v-if="task.tags.length" class="faint"
                  >#{{ task.tags.join(" #") }}</span
                >
              </div>
            </button>
          </template>
        </template>

        <p v-if="!loading && !visibleTasks.length" class="empty">
          No tasks here yet.
        </p>
        <p v-else-if="!loading" class="faint reorder-hint">
          Drag to reorder, or Alt+↑/↓. The top task is what
          <span class="mono">/work-task</span> picks up.
          <template v-if="grouped">
            Drag a row onto a heading to move it into that group.
          </template>
        </p>
      </div>
      <div v-if="selectedRefs.size" class="combine-panel">
        <strong>{{ selectedRefs.size }} selected</strong>
        <!-- Grouping a batch belongs with the other thing you do to a batch.
             It is also the only way to group without a mouse. -->
        <div class="row" style="margin: 8px 0">
          <select
            aria-label="Move selected tasks to a group"
            :value="''"
            @change="
              assignGroupToSelection(($event.target as HTMLSelectElement).value)
            "
          >
            <!-- The placeholder keeps the empty value, so 'no group' needs one
                 of its own rather than sharing it and becoming unselectable. -->
            <option value="" disabled>Move to group…</option>
            <option v-for="group in groups" :key="group.ref" :value="group.ref">
              {{ group.name }}
            </option>
            <option value="none">No group</option>
          </select>
        </div>
        <button class="primary" @click="combineSelected">
          {{
            selectedRefs.size === 1
              ? "Review & prepare branch"
              : "Review & combine branches"
          }}
        </button>
        <p v-if="selectedRefs.size === 1" class="faint">
          Only Dev Complete or Verified tasks can be prepared. The task's work
          is copied onto a delivery branch you name, ready for a PR. Closing
          requires the task to be Verified.
        </p>
        <p v-else class="faint">
          Only Dev Complete or Verified tasks can be combined. Their branches
          are cherry-picked in task-list order. Closing requires every selected
          task to be Verified.
        </p>
      </div>
    </aside>

    <!-- -------------------------------------------------------- notes list -->
    <aside v-else-if="location === '/notes'" class="sidebar">
      <div class="sidebar-header">
        <h1>Notes</h1>
        <div class="row">
          <input
            v-model="notesFilter.q"
            class="note-search"
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
          />
          <button
            class="primary"
            :disabled="!notesWorkspace?.exists"
            title="New note"
            @click="creatingNote = true"
          >
            New
          </button>
        </div>
        <div
          v-if="noteFolders.length || noteTags.length"
          class="row"
          style="margin-top: 8px"
        >
          <select
            v-if="noteFolders.length"
            v-model="notesFilter.folder"
            aria-label="Filter by folder"
          >
            <option value="">All folders</option>
            <option v-for="folder in noteFolders" :key="folder" :value="folder">
              {{ folder }}
            </option>
          </select>
          <select
            v-if="noteTags.length"
            v-model="notesFilter.tag"
            aria-label="Filter by tag"
          >
            <option value="">All tags</option>
            <option v-for="tag in noteTags" :key="tag" :value="tag">
              #{{ tag }}
            </option>
          </select>
        </div>
      </div>

      <div class="task-list">
        <button
          v-for="note in notes"
          :key="note.path"
          class="task-item"
          :class="{ selected: selectedNote?.path === note.path }"
          @click="selectNote(note.path)"
        >
          <div class="row">
            <span v-if="note.folder" class="mono faint"
              >{{ note.folder }}/</span
            >
            <span class="spacer" />
            <span class="faint">{{ note.updatedAt.slice(0, 10) }}</span>
          </div>
          <div class="task-item-title">{{ note.title }}</div>
          <div v-if="note.excerpt" class="faint note-excerpt">
            {{ note.excerpt }}
          </div>
          <div v-if="note.tags.length" class="faint">
            #{{ note.tags.join(" #") }}
          </div>
        </button>

        <p
          v-if="!notesLoading && !notes.length && notesWorkspace?.exists"
          class="empty"
        >
          {{
            notesFilter.q || notesFilter.tag || notesFilter.folder
              ? "Nothing matches that."
              : "No notes yet. Write the first one."
          }}
        </p>
      </div>

      <!-- The notes folder is an ordinary Git repository, so its state belongs
           on screen: an edit that was never committed is an edit that is only on
           this machine. -->
      <div v-if="notesWorkspace" class="notes-status">
        <p class="mono faint" :title="notesWorkspace.dir">
          {{ notesWorkspace.dir }}
        </p>
        <template v-if="!notesWorkspace.exists">
          <p class="faint">That folder does not exist yet.</p>
          <button class="primary" :disabled="notesLoading" @click="initNotes">
            Create it
          </button>
        </template>
        <template v-else-if="!notesWorkspace.git.repo">
          <p class="faint">Not a Git repository — nothing here is versioned.</p>
          <button :disabled="notesLoading" @click="initNotes">git init</button>
        </template>
        <template v-else>
          <p class="faint">
            <span class="mono">{{
              notesWorkspace.git.branch ?? "detached"
            }}</span>
            ·
            {{
              notesWorkspace.git.dirty
                ? `${notesWorkspace.git.dirty} uncommitted`
                : "clean"
            }}
            <template v-if="notesWorkspace.git.unpushed">
              · {{ notesWorkspace.git.unpushed }} unpushed
            </template>
            <template v-if="notesWorkspace.autoCommit">
              · auto-commit on</template
            >
          </p>
          <div class="row">
            <button
              :disabled="notesLoading"
              title="Fetch and fast-forward the notes repository"
              @click="pullNotes"
            >
              Sync
            </button>
            <button
              :disabled="notesLoading || !notesWorkspace.git.dirty"
              @click="syncNotes(false)"
            >
              Commit
            </button>
            <button
              :disabled="notesLoading || !notesWorkspace.git.upstream"
              :title="
                notesWorkspace.git.upstream ??
                'No upstream configured for this repository.'
              "
              @click="syncNotes(true)"
            >
              Push
            </button>
          </div>
        </template>
      </div>
    </aside>

    <!-- ---------------------------------------------------- issues filters -->
    <aside v-else-if="location === '/issues'" class="sidebar">
      <div class="sidebar-header">
        <h1>Issues</h1>
        <p class="faint" style="margin: 0 0 10px">
          Read from the JSON files in the notes folder. Sync pulls that
          repository; nothing here is written back to an issue tracker.
        </p>
        <input
          v-model="issuesFilter.q"
          class="note-search"
          type="search"
          placeholder="Search issues"
          aria-label="Search issues"
        />
      </div>

      <div class="task-list issue-filters">
        <div class="field">
          <label for="issue-state">State</label>
          <select id="issue-state" v-model="issuesFilter.state">
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>

        <!-- One provider today, more later: the filter is a list rather than a
             toggle so a second source needs nothing here but its own files. -->
        <div v-if="issueFacets.sources.length > 1" class="field">
          <label for="issue-source">Source</label>
          <select id="issue-source" v-model="issuesFilter.source">
            <option value="">All sources</option>
            <option
              v-for="entry in issueFacets.sources"
              :key="entry.source"
              :value="entry.source"
            >
              {{ ISSUE_SOURCE_LABELS[entry.source] ?? entry.source }} ({{
                entry.count
              }})
            </option>
          </select>
        </div>

        <div v-if="issueFacets.labels.length" class="field">
          <label for="issue-label">Label</label>
          <select id="issue-label" v-model="issuesFilter.label">
            <option value="">All labels</option>
            <option
              v-for="label in issueFacets.labels"
              :key="label"
              :value="label"
            >
              {{ label }}
            </option>
          </select>
        </div>

        <p class="faint">
          {{ issues.length }} of {{ issueFacets.total }} shown.
          <template v-if="issueFacets.sources.length">
            <br />
            {{
              issueFacets.sources
                .map(
                  (entry) =>
                    `${ISSUE_SOURCE_LABELS[entry.source] ?? entry.source}: ${entry.count}`,
                )
                .join(" · ")
            }}
          </template>
        </p>
      </div>

      <!-- The same folder, and the same pull, as the Notes view — whoever is
           looking at issues is the one who wants them current. -->
      <div v-if="notesWorkspace" class="notes-status">
        <p class="mono faint" :title="notesWorkspace.dir">
          {{ notesWorkspace.dir }}
        </p>
        <template v-if="!notesWorkspace.git.repo">
          <p class="faint">Not a Git repository — there is nothing to pull.</p>
        </template>
        <template v-else>
          <p class="faint">
            <span class="mono">{{
              notesWorkspace.git.branch ?? "detached"
            }}</span>
            <template v-if="notesWorkspace.git.lastCommit">
              · {{ notesWorkspace.git.lastCommit.shortSha }}
            </template>
          </p>
          <button
            :disabled="issuesLoading"
            title="Fetch and fast-forward the notes repository"
            @click="pullNotes"
          >
            Sync
          </button>
        </template>
      </div>
    </aside>

    <!-- ----------------------------------------------------- branches list -->
    <!-- The catch-all sidebar, skipped by the full-width views. -->
    <aside v-else-if="!fullWidth" class="sidebar">
      <div class="sidebar-header">
        <h1>Branches</h1>
        <p class="faint" style="margin: 0">
          Delivery branches built by combining tasks.
        </p>
      </div>

      <div class="task-list">
        <button
          v-for="branch in branches"
          :key="branch.branchName"
          class="task-item"
          :class="{ selected: selectedBranch === branch.branchName }"
          @click="selectedBranch = branch.branchName"
        >
          <div class="row">
            <span
              class="badge"
              :class="branch.prUrl ? 'verified' : 'in_progress'"
            >
              {{ branch.prUrl ? `PR #${branch.prNumber ?? "?"}` : "No PR" }}
            </span>
            <span class="spacer" />
            <span class="faint">{{ branch.git.commits.length }} commit(s)</span>
          </div>
          <div class="task-item-title mono">{{ branch.branchName }}</div>
          <div class="faint">
            {{ branch.taskRefs.join(", ") || "no tasks recorded" }}
          </div>
        </button>

        <p v-if="!branchesLoading && !branches.length" class="empty">
          No delivery branches yet. Select a finished task under Tasks to
          prepare its branch, or two or more to combine them.
        </p>
      </div>
    </aside>

    <!-- ----------------------------------------------------------- detail -->
    <InvestigationDetail
      v-if="location === '/investigations' && selectedInvestigation"
      :key="selectedInvestigation.ref"
      :investigation="selectedInvestigation"
      @changed="onInvestigationChanged"
      @deleted="onInvestigationDeleted"
      @open-task="openTask"
    />

    <GroupDetail
      v-else-if="selectedGroup"
      :key="selectedGroup.ref"
      :group="selectedGroup"
      @changed="onGroupChanged"
      @deleted="onGroupDeleted"
      @open-task="openTask"
      @open-branch="openBranch"
    />

    <TaskDetail
      v-else-if="location === '/tasks' && selected"
      :key="selected.ref"
      :task="selected"
      :aio-vr-ready="
        Boolean(meta?.aioVrInstalled && meta?.aioVrWorkspaceExists)
      "
      :all-tasks="tasks"
      :groups="groups"
      @changed="onChanged"
      @deleted="onDeleted"
      @open-investigation="openInvestigation"
      @open-task="openTask"
    />

    <TaskSchedule
      v-else-if="location === '/plan'"
      :tasks="tasks"
      :groups="groups"
      :selected-ref="selected?.ref ?? null"
      @open-task="openTask"
      @changed="refreshList"
    />

    <BaselineDetail
      v-else-if="location === '/baselines' && baselines"
      :report="baselines"
      @changed="baselines = $event"
    />

    <CombineBranches
      v-else-if="location === '/combine'"
      :refs="[...selectedRefs]"
      @close="navigateTo('tasks')"
      @started="combineStarted"
    />

    <NoteDetail
      v-else-if="location === '/notes' && selectedNote"
      :key="selectedNote.path"
      :note="selectedNote"
      @changed="onNoteChanged"
      @deleted="onNoteDeleted"
      @renamed="selectNote"
    />

    <IssueDetail
      v-else-if="location === '/issues' && selectedIssue"
      :key="selectedIssue.id"
      :issue="selectedIssue"
      @back="selectedIssue = null"
    />

    <IssueCards
      v-else-if="location === '/issues'"
      :issues="issues"
      :loading="issuesLoading"
      :filtered="issuesFiltered"
      :notes-dir="notesWorkspace?.dir ?? null"
      @open="openIssue"
    />

    <BranchDetail
      v-else-if="location === '/branches' && currentBranch"
      :key="currentBranch.branchName"
      :branch="currentBranch"
      :meta="meta"
      @changed="onBranchChanged"
      @forgotten="onBranchForgotten"
      @open-task="openTask"
      @continue-combine="continueCombine"
    />

    <section v-else class="detail">
      <p class="empty">
        <template v-if="location === '/branches'">
          {{
            branchesLoading
              ? "Loading…"
              : "Prepare or combine some tasks to get a delivery branch here."
          }}
        </template>
        <template v-else-if="location === '/notes'">
          {{
            notesLoading
              ? "Loading…"
              : notesWorkspace && !notesWorkspace.exists
                ? "The notes folder does not exist yet. Create it from the panel on the left."
                : "Select a note, or write a new one. They are Markdown files in their own Git repository."
          }}
        </template>
        <template v-else-if="location === '/investigations'">
          {{
            investigationsLoading
              ? "Loading…"
              : "Write down what is worth looking into, then run it to get tasks out of it."
          }}
        </template>
        <template v-else>
          {{
            loading
              ? "Loading…"
              : "Select a task, or create one to get started."
          }}
        </template>
      </p>
    </section>

    <!-- ------------------------------------------------------------- error -->
    <!-- Outside every pane on purpose. This used to live in the empty-detail
         section, which renders only when nothing is selected — so a failed
         action on a selected task reverted the list with nothing said. -->
    <div v-if="error" class="toast" role="alert">
      <span>{{ error }}</span>
      <button class="toast-dismiss" aria-label="Dismiss" @click="error = null">
        ×
      </button>
    </div>

    <!-- The same corner, for something that went right and is worth a word:
         a pull that brought nothing back looks identical to one that failed
         unless it says so. -->
    <div v-else-if="notice" class="toast ok" role="status">
      <span>{{ notice }}</span>
      <button class="toast-dismiss" aria-label="Dismiss" @click="notice = null">
        ×
      </button>
    </div>

    <!-- ------------------------------------------------- new investigation -->
    <div
      v-if="creatingInvestigation"
      class="overlay"
      @click.self="creatingInvestigation = false"
    >
      <div class="dialog">
        <h3>New investigation</h3>
        <div class="field">
          <label for="new-inv-title">Title</label>
          <input
            id="new-inv-title"
            v-model="newInvestigation.title"
            placeholder="Why is the plan gantt slow on mobile?"
            autofocus
          />
        </div>
        <div class="field">
          <label for="new-inv-brief">What to investigate</label>
          <textarea
            id="new-inv-brief"
            v-model="newInvestigation.brief"
            style="min-height: 180px"
            placeholder="What you want looked into, and anything you already know — a symptom, a file, a hunch. The agent reads this."
          />
        </div>
        <div class="row">
          <button
            class="primary"
            :disabled="!newInvestigation.title.trim()"
            @click="createInvestigation"
          >
            Create
          </button>
          <button @click="creatingInvestigation = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- ---------------------------------------------------------- new note -->
    <div v-if="creatingNote" class="overlay" @click.self="creatingNote = false">
      <div class="dialog">
        <h3>New note</h3>
        <div class="field">
          <label for="new-note-title">Title</label>
          <input
            id="new-note-title"
            v-model="newNote.title"
            autofocus
            @keyup.enter="createNote"
          />
        </div>
        <div class="field">
          <label for="new-note-folder">
            Folder
            <span class="faint"
              >(optional; the file is named from the title)</span
            >
          </label>
          <input
            id="new-note-folder"
            v-model="newNote.folder"
            list="note-folders"
            placeholder="ideas"
          />
          <datalist id="note-folders">
            <option
              v-for="folder in noteFolders"
              :key="folder"
              :value="folder"
            />
          </datalist>
        </div>
        <div class="row">
          <button
            class="primary"
            :disabled="!newNote.title.trim()"
            @click="createNote"
          >
            Create
          </button>
          <button @click="creatingNote = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------- group editor -->
    <div v-if="groupDraft" class="overlay" @click.self="groupDraft = null">
      <div class="dialog">
        <h3>{{ groupDraft.ref ? `Edit ${groupDraft.ref}` : "New group" }}</h3>
        <div class="field">
          <label for="group-name">Name</label>
          <input
            id="group-name"
            v-model="groupDraft.name"
            placeholder="Search rework"
            autofocus
            @keyup.enter="saveGroup"
          />
        </div>
        <div class="field">
          <label for="group-desc"
            >Description <span class="faint">(optional)</span></label
          >
          <textarea
            id="group-desc"
            v-model="groupDraft.description"
            style="min-height: 70px"
          />
        </div>
        <div class="field">
          <label for="group-branch">Branch</label>
          <input
            id="group-branch"
            v-model="groupDraft.branchName"
            class="mono"
            placeholder="group/search-rework"
            @input="groupBranchTouched = true"
          />
          <p class="faint">
            Tasks in this group are cut from this branch and merged back into it
            when they reach Dev Complete, so the group ships as one PR. It is
            created in Git the first time a task in the group is branched.
          </p>
        </div>
        <div class="field">
          <label>Colour</label>
          <!-- A fixed palette rather than a colour picker: these are the ones
               that stay legible as a 3px band in both themes. -->
          <div class="row group-colors">
            <button
              v-for="color in GROUP_COLORS"
              :key="color"
              class="group-color"
              :class="{ chosen: groupDraft.color === color }"
              :style="{ background: color }"
              :aria-label="color"
              :aria-pressed="groupDraft.color === color"
              @click="groupDraft.color = color"
            />
          </div>
        </div>
        <div class="row">
          <button
            class="primary"
            :disabled="!groupDraft.name.trim() || groupBusy"
            @click="saveGroup"
          >
            {{ groupBusy ? "Saving…" : groupDraft.ref ? "Save" : "Create" }}
          </button>
          <button :disabled="groupBusy" @click="groupDraft = null">
            Cancel
          </button>
          <span class="spacer" />
          <button
            v-if="groupDraft.ref"
            class="danger"
            :disabled="groupBusy"
            @click="removeGroup(groupDraft.ref)"
          >
            Delete group
          </button>
        </div>
        <p v-if="groupDraft.ref" class="faint">
          Deleting a group keeps its tasks — they simply stop being in one.
        </p>
      </div>
    </div>

    <!-- ---------------------------------------------------------- new task -->
    <div v-if="creating" class="overlay" @click.self="creating = false">
      <div class="dialog">
        <h3>New task</h3>
        <div class="field">
          <label for="new-title">Title</label>
          <input
            id="new-title"
            v-model="newTask.title"
            autofocus
            @keyup.enter="createTask"
          />
        </div>
        <div class="field">
          <label for="new-desc">Description</label>
          <textarea id="new-desc" v-model="newTask.description" />
        </div>
        <div class="field">
          <label for="new-branch"
            >Branch name
            <span class="faint">(optional; generated from title)</span></label
          >
          <input
            id="new-branch"
            v-model="newTask.branchName"
            placeholder="feature/t-42-my-task"
          />
        </div>
        <div class="row">
          <div class="field" style="flex: 1">
            <label for="new-priority">Priority</label>
            <select id="new-priority" v-model="newTask.priority">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
          <div class="field" style="flex: 1">
            <label for="new-units">Units</label>
            <input
              id="new-units"
              v-model.number="newTask.estimateUnits"
              type="number"
              min="1"
            />
          </div>
          <div class="field" style="flex: 2">
            <label for="new-tags">Tags (comma separated)</label>
            <input id="new-tags" v-model="newTask.tags" />
          </div>
        </div>
        <div class="field">
          <label for="new-group"
            >Group <span class="faint">(optional)</span></label
          >
          <select id="new-group" v-model="newTask.groupRef">
            <option value="">No group</option>
            <option v-for="group in groups" :key="group.ref" :value="group.ref">
              {{ group.name }}
            </option>
          </select>
        </div>
        <div class="row">
          <button
            class="primary"
            :disabled="!newTask.title.trim()"
            @click="createTask"
          >
            Create
          </button>
          <button @click="creating = false">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>
