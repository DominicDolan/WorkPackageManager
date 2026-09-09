import { api } from '../../../web/api';
import type { WorkspaceSnapshot } from '../types/workspace';

export async function loadWorkspace(): Promise<WorkspaceSnapshot> {
  const [groups, tasks, investigations, branchResult, meta] = await Promise.all([
    api.listGroups(),
    api.listTasks(),
    api.listInvestigations(),
    api.listBranches(),
    api.meta(),
  ]);

  return {
    groups,
    tasks,
    investigations,
    branches: branchResult.branches,
    currentBranch: branchResult.currentBranch,
    localBranches: branchResult.localBranches,
    aioVrReady: meta.aioVrInstalled && meta.aioVrWorkspaceExists,
    tools: meta.tools,
  };
}
