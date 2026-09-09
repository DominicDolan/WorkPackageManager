import type {
  CombinedBranchDetail,
  Investigation,
  Task,
  TaskGroupSummary,
} from "@shared/types"
import type { Meta } from "../../../web/api"

export interface WorkspaceSnapshot {
  groups: TaskGroupSummary[]
  tasks: Task[]
  investigations: Investigation[]
  branches: CombinedBranchDetail[]
  currentBranch: string | null
  localBranches: string[]
  aioVrReady: boolean
  tools: Meta["tools"]
}
