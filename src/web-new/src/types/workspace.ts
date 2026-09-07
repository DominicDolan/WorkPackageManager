import type { CombinedBranchDetail, Investigation, Task, TaskGroupSummary } from '@shared/types';

export interface WorkspaceSnapshot {
  groups: TaskGroupSummary[];
  tasks: Task[];
  investigations: Investigation[];
  branches: CombinedBranchDetail[];
  aioVrReady: boolean;
}
