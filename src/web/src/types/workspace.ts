import type {
    CombinedBranchDetail,
    Investigation,
    Task,
    WorkPackageSummary,
} from "@shared/types"
import type { Meta } from "../api"

export interface WorkspaceSnapshot {
    workPackages: WorkPackageSummary[]
    tasks: Task[]
    investigations: Investigation[]
    branches: CombinedBranchDetail[]
    currentBranch: string | null
    localBranches: string[]
    aioVrReady: boolean
    tools: Meta["tools"]
}
