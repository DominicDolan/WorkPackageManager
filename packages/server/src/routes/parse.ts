/** Turning request bodies into the domain's types, field by field. */
import type { CreateWorkPackageBranchInput } from "@work-task-manager/core/repo"
import {
    AGENT_HARNESSES,
    AGENT_PERMISSION_MODES,
    parseEstimateUnits,
    type AgentHarnessId,
    type AgentPermissionMode,
    type GitConflict,
    type PipelinePlan,
    type RunSupervisor,
} from "@work-task-manager/shared"
import { HttpError } from "../http"

export interface SupervisorInput {
    harness?: string
    model?: string
    permissionMode?: string
    extra?: string
}

/** A run supervisor from a request body, null for none, or why it is not one. */
export function parseSupervisor(
    input: SupervisorInput | null | undefined,
): RunSupervisor | null | string {
    if (!input) return null
    if (!AGENT_HARNESSES.includes(input.harness as AgentHarnessId))
        return `supervisor.harness must be one of: ${AGENT_HARNESSES.join(", ")}.`
    if (
        input.permissionMode !== undefined &&
        !AGENT_PERMISSION_MODES.includes(
            input.permissionMode as AgentPermissionMode,
        )
    )
        return `supervisor.permissionMode must be one of: ${AGENT_PERMISSION_MODES.join(", ")}.`
    return {
        harness: input.harness as AgentHarnessId,
        model: input.model ?? "",
        permissionMode: (input.permissionMode ??
            "bypassPermissions") as AgentPermissionMode,
        extra: input.extra ?? "",
    }
}

/** A start-to-finish run's plan as the browser sends it, checked field by
 *  field. The work package's own records are checked against it later. */
export function parsePipelinePlan(raw: unknown): PipelinePlan | string {
    if (!raw || typeof raw !== "object")
        return "A start-to-finish run needs a plan."
    const value = raw as Record<string, unknown>
    const agent = parseSupervisor(value.agent as SupervisorInput | undefined)
    if (typeof agent === "string") return agent.replace("supervisor.", "agent.")
    if (!agent) return "plan.agent is required."
    const strings = (list: unknown) =>
        Array.isArray(list) && list.every((one) => typeof one === "string")
    if (!strings(value.investigations))
        return "plan.investigations must be an array of investigation refs."
    if (
        !Array.isArray(value.branches) ||
        !value.branches.every((one) => Number.isInteger(one))
    )
        return "plan.branches must be an array of branch ids."
    // Absent or null leaves the tasks alone.
    const taskRun = (value.taskRun ?? null) as Record<string, unknown> | null
    if (
        taskRun !== null &&
        (typeof taskRun !== "object" ||
            typeof taskRun.model !== "string" ||
            typeof taskRun.extra !== "string")
    )
        return "plan.taskRun must be { model, extra }, or null to leave the tasks alone."
    if (taskRun?.excluded !== undefined && !strings(taskRun.excluded))
        return "plan.taskRun.excluded must be an array of task refs."
    if (taskRun?.selected !== undefined && !strings(taskRun.selected))
        return "plan.taskRun.selected must be an array of task refs."
    return {
        agent,
        investigations: value.investigations as string[],
        taskRun: taskRun && {
            model: taskRun.model as string,
            extra: taskRun.extra as string,
            excluded: taskRun.excluded as string[] | undefined,
            selected: taskRun.selected as string[] | undefined,
        },
        branches: value.branches as number[],
    }
}

export function parseTags(value: unknown): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value))
        throw new Error("tags must be an array of strings.")
    return value.map((tag) => String(tag).trim()).filter(Boolean)
}

/** A plan estimate from a request body, absent staying absent so a PATCH that
 *  does not mention it leaves the stored one alone. */
export function parseUnits(value: unknown): number | undefined {
    return value === undefined ? undefined : parseEstimateUnits(value)
}

/** A list of task refs from a request body. Absent stays absent — an empty
 *  array is a deliberate "no dependencies" and must not be confused with it. */
export function parseRefs(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string")) {
        throw new Error(`${field} must be an array of task references.`)
    }
    return (value as string[]).map((ref) => ref.trim()).filter(Boolean)
}

/** A conflict report as the client sends it back, checked field by field: it
 *  decides the directory an agent is started in. */
export function parseConflict(raw: unknown): GitConflict | null {
    if (!raw || typeof raw !== "object") return null
    const value = raw as Record<string, unknown>
    if (value.operation !== "merge" && value.operation !== "rebase") return null
    if (value.scope !== "repo" && value.scope !== "notes") return null
    if (typeof value.branch !== "string" || !value.branch.trim()) return null
    if (typeof value.onto !== "string" || !value.onto.trim()) return null
    const files = Array.isArray(value.files)
        ? value.files.filter((file): file is string => typeof file === "string")
        : []
    return {
        operation: value.operation,
        scope: value.scope,
        branch: value.branch.trim(),
        onto: value.onto.trim(),
        files,
        detail: typeof value.detail === "string" ? value.detail : "",
    }
}

/** A branch as the browser describes one — every field optional. */
export interface BranchInput {
    label?: string
    branchName?: string
    existing?: boolean
    baseBranch?: string | null
    taskRefs?: string[]
}

export function branchInput(
    input: BranchInput,
): Omit<CreateWorkPackageBranchInput, "workPackageRef"> {
    return {
        label: typeof input.label === "string" ? input.label : undefined,
        branchName:
            typeof input.branchName === "string" ? input.branchName : undefined,
        existing: input.existing === true,
        baseBranch:
            typeof input.baseBranch === "string" ? input.baseBranch : null,
        taskRefs: Array.isArray(input.taskRefs)
            ? input.taskRefs.filter((one) => typeof one === "string")
            : undefined,
    }
}

/** A supervisor from a request body, null for none; a bad one is a 400. */
export function requireSupervisor(
    input: SupervisorInput | null | undefined,
): RunSupervisor | null {
    const parsed = parseSupervisor(input)
    if (typeof parsed === "string") throw new HttpError(400, parsed)
    return parsed
}

/** Reject an unknown permission mode; absent is fine. */
export function checkPermissionMode(value: unknown): void {
    if (
        value !== undefined &&
        !AGENT_PERMISSION_MODES.includes(value as AgentPermissionMode)
    )
        throw new HttpError(
            400,
            `permissionMode must be one of: ${AGENT_PERMISSION_MODES.join(", ")}.`,
        )
}

/** A list of strings, or a 400 saying what it should have been. */
export function stringList(value: unknown, message: string): string[] {
    if (!Array.isArray(value) || !value.every((one) => typeof one === "string"))
        throw new HttpError(400, message)
    return value as string[]
}

/** A route param that must be an integer id. */
export function intParam(value: string | undefined, what = "A run id"): number {
    const id = Number(value)
    if (!Number.isInteger(id))
        throw new HttpError(400, `${what} must be a number.`)
    return id
}

/** Files from a multipart upload's `file` fields. */
export async function uploadedFiles(request: Request): Promise<File[]> {
    let form: FormData
    try {
        form = await request.formData()
    } catch {
        throw new HttpError(
            400,
            "Attachments must be uploaded as multipart/form-data.",
        )
    }
    const files = form
        .getAll("file")
        .filter((entry): entry is File => entry instanceof File)
    if (!files.length) throw new HttpError(400, "No file was uploaded.")
    return files
}
