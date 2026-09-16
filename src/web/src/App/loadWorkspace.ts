import { api } from "../api"
import type { WorkspaceSnapshot } from "../types/workspace"

export async function loadWorkspace(): Promise<WorkspaceSnapshot> {
  const [workPackages, tasks, investigations, branchResult, meta] =
    await Promise.all([
      api.listWorkPackages(),
      api.listTasks(),
      api.listInvestigations(),
      api.listBranches(),
      api.meta(),
    ])

  return {
    workPackages,
    tasks,
    investigations,
    branches: branchResult.branches,
    currentBranch: branchResult.currentBranch,
    localBranches: branchResult.localBranches,
    aioVrReady: meta.aioVrInstalled && meta.aioVrWorkspaceExists,
    tools: meta.tools,
  }
}
