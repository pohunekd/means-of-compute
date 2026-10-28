// Approvals view: a cache-free read of the approvals requests file for
// the driver. Every call re-reads the file; a missing file reads as
// empty. ApprovalsDataError propagates and the scheduler treats it as
// fatal.
import { approvedMerge, fleetPause, readApprovals } from "../approvals/store.js";

export interface ApprovalsView {
  fleetPaused(): Promise<boolean>;
  approvedMerge(workItemId: string, pull: number, headSha: string): Promise<boolean>;
}

export function createApprovalsView(requestsPath: string): ApprovalsView {
  return {
    async fleetPaused(): Promise<boolean> {
      const doc = await readApprovals(requestsPath);
      return fleetPause(doc).paused;
    },
    async approvedMerge(workItemId: string, pull: number, headSha: string): Promise<boolean> {
      const doc = await readApprovals(requestsPath);
      return approvedMerge(doc, workItemId, pull, headSha) !== null;
    },
  };
}
