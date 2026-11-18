import {
    findAgentRun,
    onRunSettled,
    startRun,
    stopRun,
    unattendedSupervisor,
} from "./agents"
import {
    branchExists,
    currentBranch,
    generatePrDescription,
    pushBranch,
} from "./branches"
import {
    checksSupervised,
    checksSupervision,
    onChecksSupervisionSettled,
    startSupervisedChecks,
    stopSupervisedChecks,
} from "./checksSupervisor"
import { configuredChecks } from "./checks"
import { getDb, nowIso } from "./db"
import { openPullRequest } from "./pullRequests"
import {
    clearRebaseSupervision,
    rebaseSupervision,
    stopRebaseSupervisor,
    superviseRebaseConflict,
} from "./rebaseSupervisor"
import {
    findInvestigation,
    findWorkPackageRun,
    listWorkPackageBranches,
    requireWorkPackage,
    requireWorkPackageBranch,
    runningWorkPackageRuns,
    setBranchTasks,
    updateCombinedBranch,
} from "./repo"
import { announceChange } from "./watch"
import {
    getWorkPackageDetail,
    rebaseBranchOnBase,
    workPackageBranchDetail,
} from "./workPackageBranch"
import {
    resumeWorkPackageRun,
    startWorkPackageRun,
    stopWorkPackageRun,
} from "./workPackageRuns"
import { workspace } from "./config/paths"
import {
    BRANCH_STEPS,
    RECOMMENDED_MODEL,
    type PipelineDetail,
    type PipelinePlan,
    type PipelineResumeSettings,
    type PipelineStep,
    type PipelineStepDetail,
    type WorkPackageBranch,
    type WorkPackageRunStatus,
    type WorkRunAgent,
} from "@work-task-manager/shared"

/**
 * A work package worked from start to finish, as one Run tab.
 *
 * The stages run in order: each investigation, then each task run, then each
 * branch taken through rebase, description, checks and pull request. Every
 * stage hands off to machinery that already exists — `/plan-tasks`, the
 * unattended loop, the supervised rebase and the supervised checks — and one
 * agent setting drives all of it: it investigates, and it is the supervisor
 * each of the others calls in.
 *
 * ## Moving on
 *
 * Nothing here polls. A stage is judged whenever something it could be waiting
 * on settles: any agent run exiting, or a supervised checks run finishing.
 * Judging asks the record of the thing itself — the investigation's status,
 * the loop's, Git's — rather than trusting an exit code, for the same reasons
 * the loop gives.
 *
 * ## Stopping
 *
 * Like the loop, everything fails towards stopping. A stage that stops short
 * settles the whole run with the stage's own reason, and Resume starts that
 * stage again. What earlier stages did stays done.
 */

interface PipelineRecord {
    plan: PipelinePlan
    steps: PipelineStep[]
    status: WorkPackageRunStatus
    stopReason: string
}

interface PipelineRow {
    id: number
    work_package_ref: string
    pipeline_json: string | null
}

/** Told to the investigator on top of `/plan-tasks`, which assumes someone is
 *  there to ask. */
const UNATTENDED_INVESTIGATION = `## Nobody is watching this run

This investigation is the first stage of an unattended run. When it is
complete, the run goes on to its configured task and branch stages. Nobody
is here to answer a question or approve the task list:

- Do not stop to ask. Where you would ask, decide from the brief, the code and
  the notes, and say what you decided in the findings.
- List the tasks in your report, but file them without waiting for approval.
- If you would file more than 8, file the 8 that matter most and name the rest
  in the findings.
- Finish with \`tasks investigation complete\`. The run only moves on once the
  investigation is complete, so an investigation left open stops it.`

function readRecord(id: number): PipelineRecord | null {
    const row = getDb()
        .query<{ pipeline_json: string | null }, { $id: number }>(
            "SELECT pipeline_json FROM work_runs WHERE id = $id",
        )
        .get({ $id: id })
    return row?.pipeline_json
        ? (JSON.parse(row.pipeline_json) as PipelineRecord)
        : null
}

function writeRecord(id: number, record: PipelineRecord): void {
    getDb()
        .query(
            "UPDATE work_runs SET pipeline_json = $json, updated_at = $at WHERE id = $id",
        )
        .run({ $id: id, $json: JSON.stringify(record), $at: nowIso() })
    announceChange("tasks")
}

function pipelineRows(): PipelineRow[] {
    return getDb()
        .query<PipelineRow, []>(
            "SELECT id, work_package_ref, pipeline_json FROM work_runs WHERE kind = 'pipeline' ORDER BY id",
        )
        .all()
}

function runningPipelines(): { id: number; workPackageRef: string }[] {
    return pipelineRows()
        .filter(
            (row) =>
                row.pipeline_json &&
                (JSON.parse(row.pipeline_json) as PipelineRecord).status ===
                    "running",
        )
        .map((row) => ({ id: row.id, workPackageRef: row.work_package_ref }))
}

/** Why a new or resumed pipeline cannot go now: one working tree takes one
 *  run at a time, whichever kind it is. */
function whyBusy(): string | null {
    const pipeline = runningPipelines()[0]
    if (pipeline)
        return `${pipeline.workPackageRef} is already being worked start to finish (run ${pipeline.id}). Stop it first.`
    const loop = runningWorkPackageRuns()[0]
    if (loop)
        return `${loop.workPackageRef} is already being worked by work package run ${loop.id}. Stop it first.`
    return null
}

function stepsFor(plan: PipelinePlan): PipelineStep[] {
    const fresh = { state: "waiting" as const, detail: "" }
    return [
        ...plan.investigations.map((ref): PipelineStep => ({
            ...fresh,
            kind: "investigation",
            ref,
            agentRunIds: [],
        })),
        ...(plan.taskRun
            ? [{ ...fresh, kind: "tasks" as const, workPackageRunId: null }]
            : []),
        ...plan.branches.flatMap((branchId) => {
            const branch = requireWorkPackageBranch(branchId)
            return BRANCH_STEPS.map((step): PipelineStep => ({
                ...fresh,
                kind: "branch",
                step,
                branchId,
                branchName: branch.branchName,
            }))
        }),
    ]
}

/* ------------------------------------------------------------- launching */

/**
 * Check a plan against its work package and record it as a new Run tab's
 * pipeline. Returns the plan made fit to run unattended; the caller inserts
 * the row and then calls `beginPipeline`.
 */
export function preparePipeline(
    workPackageRef: string,
    plan: PipelinePlan,
): { plan: PipelinePlan; record: PipelineRecord } {
    const workPackage = requireWorkPackage(workPackageRef)
    const busy = whyBusy()
    if (busy) throw new Error(busy)

    const agent = unattendedSupervisor(plan.agent, "carry the run through")
    const queued = new Map(
        getWorkPackageDetail(workPackage.ref).queue.map((task) => [
            task.ref.toLowerCase(),
            task.ref,
        ]),
    )
    const excluded = [
        ...new Set(
            (plan.taskRun?.excluded ?? []).map((ref) => ref.toLowerCase()),
        ),
    ].map((ref) => {
        const canonical = queued.get(ref)
        if (!canonical)
            throw new Error(
                `${ref} is not an unfinished task in ${workPackage.ref}.`,
            )
        return canonical
    })
    const selected =
        plan.taskRun?.selected === undefined
            ? undefined
            : [
                  ...new Set(
                      plan.taskRun.selected.map((ref) => ref.toLowerCase()),
                  ),
              ].map((ref) => {
                  const canonical = queued.get(ref)
                  if (!canonical)
                      throw new Error(
                          `${ref} is not an unfinished task in ${workPackage.ref}.`,
                      )
                  return canonical
              })
    for (const ref of plan.investigations) {
        const investigation = findInvestigation(ref)
        if (
            !investigation ||
            investigation.workPackageRef?.toLowerCase() !==
                workPackage.ref.toLowerCase()
        )
            throw new Error(
                `${ref} is not an investigation in ${workPackage.ref}.`,
            )
    }
    const own = new Set(
        listWorkPackageBranches(workPackage.ref).map((branch) => branch.id),
    )
    for (const id of plan.branches) {
        if (!own.has(id))
            throw new Error(
                `Branch ${id} is not a branch of ${workPackage.ref}.`,
            )
    }
    const normalised: PipelinePlan = {
        agent,
        investigations: [...new Set(plan.investigations)],
        taskRun: plan.taskRun && {
            model: plan.taskRun.model || RECOMMENDED_MODEL,
            extra: plan.taskRun.extra,
            excluded,
            selected,
        },
        branches: [...new Set(plan.branches)],
    }
    const steps = stepsFor(normalised)
    if (!steps.length)
        throw new Error(
            "Choose at least one investigation, the task run, or a branch to work.",
        )
    return {
        plan: normalised,
        record: { plan: normalised, steps, status: "running", stopReason: "" },
    }
}

/** Set a freshly recorded pipeline going. Deferred, so the request that
 *  started it returns before the first stage does any work. */
export function beginPipeline(id: number): void {
    setTimeout(() => progress(id), 0)
}

/* -------------------------------------------------------------- the stages */

const currentIndex = (record: PipelineRecord) =>
    record.steps.findIndex(
        (step) => step.state !== "done" && step.state !== "skipped",
    )

/** Runs with a background stage in flight — a description being written or a
 *  PR being opened. They are awaited in this process, so a restart loses them. */
const inFlight = new Set<number>()

/**
 * Carry a pipeline as far as it can go right now: judge the stage in flight,
 * start the next when it is done, and stop when one is waiting or has stopped
 * short. `resuming` marks the first stage as being picked up again.
 */
function progress(id: number, resuming = false): void {
    for (;;) {
        const record = readRecord(id)
        if (!record || record.status !== "running") return
        const index = currentIndex(record)
        if (index === -1) {
            record.status = "finished"
            record.stopReason = ""
            writeRecord(id, record)
            return
        }
        const step = record.steps[index]!
        try {
            if (step.state === "running") judge(id, record, step)
            else begin(id, record, step, resuming)
        } catch (caught) {
            step.state = "blocked"
            step.detail =
                caught instanceof Error ? caught.message : String(caught)
        }
        resuming = false

        if (step.state === "stopped" || step.state === "blocked") {
            record.status = step.state === "stopped" ? "stopped" : "blocked"
            record.stopReason = step.detail
        }
        writeRecord(id, record)
        if (step.state !== "done" && step.state !== "skipped") return
    }
}

function begin(
    id: number,
    record: PipelineRecord,
    step: PipelineStep,
    resuming: boolean,
): void {
    step.detail = ""
    const { agent } = record.plan

    if (step.kind === "investigation") {
        const investigation = findInvestigation(step.ref)
        if (!investigation) {
            step.state = "skipped"
            step.detail = `${step.ref} no longer exists.`
            return
        }
        if (investigation.status === "complete") {
            step.state = "skipped"
            step.detail = "Already complete."
            return
        }
        const run = startRun({
            harness: agent.harness,
            model: agent.model,
            mode: "print",
            command: "plan-tasks",
            target: investigation.ref,
            extra: agent.extra,
            subjectKind: "investigation",
            subjectRef: investigation.ref,
            permissionMode: agent.permissionMode,
            handoff: UNATTENDED_INVESTIGATION,
        })
        step.agentRunIds.push(run.id)
        step.state = "running"
        return
    }

    if (step.kind === "tasks") {
        const workPackageRef = workPackageOf(id)
        const previous =
            resuming && step.workPackageRunId !== null
                ? findWorkPackageRun(step.workPackageRunId)
                : null
        if (previous && previous.status !== "finished") {
            const taskRun = record.plan.taskRun!
            resumeWorkPackageRun(previous.id, previous.runIds, {
                harness: agent.harness,
                model: taskRun.model,
                permissionMode: agent.permissionMode,
                extra: taskRun.extra,
                supervisor: agent,
            })
            step.state = "running"
            return
        }
        const detail = getWorkPackageDetail(workPackageRef)
        // An investigation may have completed or moved an excluded task since
        // the plan was saved. Only pass exclusions still in the open queue.
        const omitted = new Set(
            (record.plan.taskRun!.excluded ?? []).map((ref) =>
                ref.toLowerCase(),
            ),
        )
        const selection = record.plan.taskRun!.selected
        const allowed =
            selection === undefined
                ? null
                : new Set(selection.map((ref) => ref.toLowerCase()))
        const included = detail.queue.filter(
            (task) =>
                !omitted.has(task.ref.toLowerCase()) &&
                (allowed === null || allowed.has(task.ref.toLowerCase())),
        )
        if (!included.length) {
            step.state = "done"
            step.detail = "No included tasks were left to work."
            return
        }
        placeUnbranchedTasks(record, included)
        // A task stage exists only when the plan has a task run.
        const taskRun = record.plan.taskRun!
        const started = startWorkPackageRun({
            workPackageRef,
            harness: agent.harness,
            model: taskRun.model,
            permissionMode: agent.permissionMode,
            extra: taskRun.extra,
            excluded: detail.queue
                .filter((task) => omitted.has(task.ref.toLowerCase()))
                .map((task) => task.ref),
            selected:
                selection === undefined
                    ? undefined
                    : included.map((task) => task.ref),
            supervisor: agent,
        })
        step.workPackageRunId = started.workPackageRun.id
        step.state = "running"
        addTaskRefs(
            id,
            included.map((task) => task.ref),
        )
        return
    }

    const branch = requireWorkPackageBranch(step.branchId)
    step.branchName = branch.branchName
    const current = workPackageBranchDetail(branch)
    const delivery = current.delivery
    if (delivery?.prUrl) {
        step.state = step.step === "pr" ? "done" : "skipped"
        step.detail = `Already has a pull request: ${delivery.prUrl}`
        return
    }

    if (step.step === "rebase") {
        if (!branchExists(branch.branchName))
            throw new Error(
                `'${branch.branchName}' has no commits yet, so there is nothing to deliver.`,
            )
        clearRebaseSupervision(branch.branchName)
        const from = currentBranch()
        const result = rebaseBranchOnBase(branch)
        if (result.rebased) {
            step.state = "done"
            step.detail = result.upToDate
                ? `Already up to date with '${current.base}'.`
                : `Rebased onto '${current.base}'.`
            return
        }
        const supervision = superviseRebaseConflict({
            conflict: result.conflict!,
            supervisor: agent,
            pushed: result.pushed,
            from,
        })
        if (supervision.status !== "resolving") {
            step.state = "blocked"
            step.detail = supervision.stopReason
            return
        }
        step.state = "running"
        step.detail = `Stopped on conflicts in ${result.conflict!.files.length} file(s); the supervisor is resolving them.`
        return
    }

    if (!delivery)
        throw new Error(
            `'${branch.branchName}' has no commits ahead of '${current.base}', so there is nothing to deliver.`,
        )

    if (step.step === "describe") {
        if (!workspace().config.prAgent) {
            if (!delivery.prTitle?.trim())
                throw new Error(
                    'PR description generation is disabled — set "prAgent" in .tasks/tasks.config.json, or write the description on the branch tab and resume.',
                )
            step.state = "done"
            step.detail = "Kept the description already written."
            return
        }
        inBackground(id, record, step, async () => {
            const { title, body } = await generatePrDescription(
                branch.branchName,
                current.base,
            )
            updateCombinedBranch(branch.branchName, {
                prTitle: title,
                prBody: body,
                baseBranch: current.base,
            })
            return title
        })
        return
    }

    if (step.step === "checks") {
        if (!configuredChecks().length) {
            step.state = "skipped"
            step.detail = "No checks are configured."
            return
        }
        if (checksSupervised(branch.branchName))
            throw new Error(
                `Checks on '${branch.branchName}' are already running with a supervisor.`,
            )
        startSupervisedChecks({
            branch: branch.branchName,
            base: current.base,
            resume: resuming,
            previous: delivery.checks,
            supervisor: agent,
        })
        step.state = "running"
        return
    }

    inBackground(id, record, step, async () => {
        // A branch rebased after it was pushed has to go up again first, or
        // the PR would be opened on the old history.
        if (
            current.git.upstream &&
            (current.git.diverged || current.git.unpushed)
        )
            await pushBranch({
                branch: branch.branchName,
                remoteBranch: delivery.remoteBranch,
                force: current.git.diverged,
            })
        return (await openPullRequest(branch.branchName)).url
    })
}

/**
 * Do a stage's work without holding up the server: describing a branch runs
 * an agent, and opening its PR pushes and calls `gh`, which can take minutes.
 * The stage stays running until `work` settles; its result is the stage's
 * detail when it succeeds, and a failure blocks the run.
 */
function inBackground(
    id: number,
    record: PipelineRecord,
    step: PipelineStep,
    work: () => Promise<string>,
): void {
    const index = record.steps.indexOf(step)
    step.state = "running"
    inFlight.add(id)
    work()
        .then(
            (detail) => settleStep(id, index, "done", detail),
            (caught) =>
                settleStep(
                    id,
                    index,
                    "blocked",
                    caught instanceof Error ? caught.message : String(caught),
                ),
        )
        .finally(() => inFlight.delete(id))
}

/** Record how a background stage ended, then carry on from it. */
function settleStep(
    id: number,
    index: number,
    state: "done" | "blocked",
    detail: string,
): void {
    const record = readRecord(id)
    const step = record?.steps[index]
    // Stopped by hand while it worked: what it did stands, but the run stays
    // stopped and resuming picks the stage up again.
    if (!record || !step || step.state !== "running") return
    step.state = state
    step.detail = detail
    if (state === "blocked" && record.status === "running") {
        record.status = "blocked"
        record.stopReason = detail
    }
    writeRecord(id, record)
    if (record.status === "running") setTimeout(() => progress(id), 0)
}

/** A stage in flight: has what it is waiting on settled, and how? */
function judge(id: number, record: PipelineRecord, step: PipelineStep): void {
    if (step.kind === "investigation") {
        const agent = findAgentRun(step.agentRunIds.at(-1) ?? -1)
        if (agent?.status === "running" || agent?.status === "launched") return
        if (findInvestigation(step.ref)?.status === "complete") {
            step.state = "done"
            step.detail = ""
            return
        }
        step.state = agent?.status === "stopped" ? "stopped" : "blocked"
        step.detail =
            agent?.status === "stopped"
                ? "The investigator was stopped."
                : `The investigator finished without completing ${step.ref}. Its output has the detail.`
        return
    }

    if (step.kind === "tasks") {
        const loop =
            step.workPackageRunId !== null
                ? findWorkPackageRun(step.workPackageRunId)
                : null
        if (!loop) {
            step.state = "blocked"
            step.detail = "The task run's record is missing."
            return
        }
        if (loop.status === "running") return
        if (loop.status === "finished") {
            step.state = "done"
            step.detail = `Worked ${loop.worked.length} task(s).`
            return
        }
        step.state = loop.status === "stopped" ? "stopped" : "blocked"
        step.detail = loop.stopReason
        return
    }

    if (step.step === "rebase") {
        const supervision = rebaseSupervision(step.branchName)
        if (supervision?.status === "resolving") return
        if (supervision?.status === "rebased") {
            step.state = "done"
            step.detail = `Rebased onto '${supervision.onto}' after the supervisor resolved its conflicts.`
            return
        }
        step.state = supervision?.status === "stopped" ? "stopped" : "blocked"
        step.detail =
            supervision?.stopReason ||
            "The rebase's supervisor is no longer running."
        return
    }

    if (step.step === "checks") {
        const supervision = checksSupervision(step.branchName)
        if (
            supervision?.status === "checking" ||
            supervision?.status === "fixing"
        )
            return
        if (supervision?.status === "passed") {
            step.state = "done"
            step.detail = supervision.agents.length
                ? `Passed after the supervisor fixed ${supervision.agents.length} failure(s).`
                : "Passed."
            return
        }
        step.state = supervision?.status === "stopped" ? "stopped" : "blocked"
        step.detail =
            supervision?.stopReason ||
            "The supervised checks are no longer running."
        return
    }

    if (inFlight.has(id)) return
    step.state = "blocked"
    step.detail = "It stopped before it finished."
}

/**
 * Tasks the investigations filed land on the work package's newest branch.
 * One that landed on no branch at all goes on the first branch this run
 * delivers, so its work has somewhere to be merged.
 */
function placeUnbranchedTasks(
    record: PipelineRecord,
    queue: { ref: string; useGitWorkflow: boolean; targetBranches: string[] }[],
): void {
    const first = record.plan.branches[0]
    if (first === undefined) return
    const loose = queue.filter(
        (task) => task.useGitWorkflow && !task.targetBranches.length,
    )
    if (!loose.length) return
    const branch: WorkPackageBranch = requireWorkPackageBranch(first)
    setBranchTasks(branch.id, [
        ...branch.taskRefs,
        ...loose.map((task) => task.ref),
    ])
}

function workPackageOf(id: number): string {
    const row = getDb()
        .query<{ work_package_ref: string }, { $id: number }>(
            "SELECT work_package_ref FROM work_runs WHERE id = $id",
        )
        .get({ $id: id })
    if (!row) throw new Error(`No run with id ${id}.`)
    return row.work_package_ref
}

/** Add the tasks a task run set out to work to the tab's list. */
function addTaskRefs(id: number, refs: string[]): void {
    const row = getDb()
        .query<{ task_refs_json: string }, { $id: number }>(
            "SELECT task_refs_json FROM work_runs WHERE id = $id",
        )
        .get({ $id: id })
    if (!row) return
    const known = JSON.parse(row.task_refs_json) as string[]
    const seen = new Set(known.map((ref) => ref.toLowerCase()))
    const added = refs.filter((ref) => !seen.has(ref.toLowerCase()))
    if (!added.length) return
    getDb()
        .query("UPDATE work_runs SET task_refs_json = $refs WHERE id = $id")
        .run({ $id: id, $refs: JSON.stringify([...known, ...added]) })
}

/* ------------------------------------------------------ stop and resume */

export function stopPipeline(id: number): void {
    const record = readRecord(id)
    if (!record || record.status !== "running")
        throw new Error("This run is not running.")
    const index = currentIndex(record)
    const step = index === -1 ? null : record.steps[index]!

    // Settled first, so whatever is stopped below finds a run that has already
    // stopped rather than one asking it what to do next.
    record.status = "stopped"
    record.stopReason = "Stopped by hand."
    if (step?.state === "running") {
        step.state = "stopped"
        step.detail = "Stopped by hand."
    }
    writeRecord(id, record)
    if (step?.state !== "stopped") return

    try {
        if (step.kind === "investigation") {
            const agent = step.agentRunIds.at(-1)
            if (agent !== undefined) stopRun(agent)
        } else if (step.kind === "tasks") {
            if (step.workPackageRunId !== null)
                stopWorkPackageRun(step.workPackageRunId)
        } else if (step.step === "rebase") {
            stopRebaseSupervisor(step.branchName)
        } else if (step.step === "checks") {
            stopSupervisedChecks(step.branchName)
        }
        // Describing and opening the PR are single commands, left to finish.
        // Their results are kept, and resuming does not repeat a PR opened.
    } catch {
        // Already settled on its own. Nothing to stop.
    }
}

/** Start a stopped or blocked pipeline again at the stage it stopped on. */
export function resumePipeline(
    id: number,
    settings?: PipelineResumeSettings,
): void {
    const record = readRecord(id)
    if (!record) throw new Error("This run has no pipeline to resume.")
    if (record.status === "running")
        throw new Error("This run is already running.")
    if (record.status === "finished")
        throw new Error("This run has already finished.")
    const busy = whyBusy()
    if (busy) throw new Error(busy)

    if (settings) {
        const agent = unattendedSupervisor(
            settings.agent,
            "carry the run through",
        )
        if (settings.taskRun && !record.plan.taskRun)
            throw new Error("This run has no task stage to configure.")
        record.plan.agent = agent
        if (settings.taskRun && record.plan.taskRun) {
            record.plan.taskRun.model =
                settings.taskRun.model || RECOMMENDED_MODEL
            record.plan.taskRun.extra = settings.taskRun.extra
        }
    }

    const index = currentIndex(record)
    if (index !== -1) {
        record.steps[index]!.state = "waiting"
        record.steps[index]!.detail = ""
    }
    record.status = "running"
    record.stopReason = ""
    getDb().transaction(() => {
        writeRecord(id, record)
        if (settings) {
            const agent = record.plan.agent
            getDb()
                .query(
                    "UPDATE work_runs SET harness = $harness, model = $model, permission_mode = $permission, extra = $extra WHERE id = $id",
                )
                .run({
                    $id: id,
                    $harness: agent.harness,
                    $model: agent.model,
                    $permission: agent.permissionMode,
                    $extra: agent.extra,
                })
        }
    })()
    progress(id, true)
}

/**
 * The agents and loops a pipeline was running died with the server. Settled,
 * not resumed: resuming is one click on the tab.
 */
export function reconcilePipelines(): void {
    for (const { id } of runningPipelines()) {
        const record = readRecord(id)!
        const step = record.steps[currentIndex(record)]
        if (step?.state === "running") {
            step.state = "stopped"
            step.detail = "The server restarted, which ended it."
        }
        record.status = "stopped"
        record.stopReason =
            "The server restarted, which ended what the run was doing."
        writeRecord(id, record)
    }
}

/* ------------------------------------------------------------- reading */

/** The status the tab shows, and why it stopped. Null for a run that is not
 *  a pipeline. */
export function pipelineStatus(
    id: number,
): Pick<PipelineRecord, "status" | "stopReason"> | null {
    const record = readRecord(id)
    return record && { status: record.status, stopReason: record.stopReason }
}

/** The loop a pipeline's task run started, if it has got that far. */
export function pipelineLoopIds(id: number): number[] {
    return (readRecord(id)?.steps ?? []).flatMap((step) =>
        step.kind === "tasks" && step.workPackageRunId !== null
            ? [step.workPackageRunId]
            : [],
    )
}

/** The agent at work right now, or the last one to have been. */
export function pipelineAgentRunId(id: number): number | null {
    const record = readRecord(id)
    if (!record) return null
    for (const step of [...record.steps].reverse()) {
        if (step.kind === "investigation" && step.agentRunIds.length)
            return step.agentRunIds.at(-1)!
        if (step.kind === "tasks" && step.workPackageRunId !== null) {
            const loop = findWorkPackageRun(step.workPackageRunId)
            if (loop?.currentRunId != null) return loop.currentRunId
        }
    }
    return null
}

export function pipelineDetail(id: number): PipelineDetail | null {
    const record = readRecord(id)
    if (!record) return null
    const branches = new Map(
        listWorkPackageBranches(workPackageOf(id)).map((branch) => [
            branch.id,
            branch,
        ]),
    )
    const steps = record.steps.map((step): PipelineStepDetail => {
        if (step.kind === "investigation")
            return {
                ...step,
                title: findInvestigation(step.ref)?.title ?? step.ref,
                agents: step.agentRunIds.flatMap((runId): WorkRunAgent[] => {
                    const agent = findAgentRun(runId)
                    return agent
                        ? [
                              {
                                  id: agent.id,
                                  command: agent.command,
                                  status: agent.status,
                                  exitCode: agent.exitCode,
                                  createdAt: agent.createdAt,
                                  finishedAt: agent.finishedAt,
                                  sessionId: agent.sessionId,
                              },
                          ]
                        : []
                }),
            }
        if (step.kind === "tasks")
            return {
                ...step,
                title:
                    record.plan.taskRun?.selected === undefined
                        ? "All open tasks"
                        : "Selected tasks",
                agents: [],
            }
        return {
            ...step,
            title: branches.get(step.branchId)?.label ?? step.branchName,
            agents: [],
        }
    })
    return { plan: record.plan, steps }
}

/* ------------------------------------------------------------- listeners */

let scheduled = false

/** Something a stage could be waiting on has settled: judge every running
 *  pipeline once the settling has finished. */
function kick(): void {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
        scheduled = false
        for (const { id } of runningPipelines()) progress(id)
    }, 0)
}

onRunSettled(kick)
onChecksSupervisionSettled(kick)
