// Approval decisions: decideRequest moves one pending request to
// approved or rejected under the requests lock. This module is the only
// writer of a state other than pending (A9).
import { FileLockError, withFileLock } from "../fs/lock.js";
import { writeFileAtomic } from "../fs/write.js";
import {
  ApprovalsBusyError,
  ApprovalsDataError,
  ApprovalsWriteError,
  checkApprovals,
  readApprovals,
  type ApprovalRequest,
  type ApprovalsDocument,
} from "./store.js";
import { InputPathError } from "../fs/input.js";

export type DecideOutcome =
  | { readonly kind: "decided" | "unchanged"; readonly request: ApprovalRequest }
  | { readonly kind: "refused"; readonly code: "unknown-request" | "already-decided" };

function toWriteError(error: unknown): ApprovalsWriteError {
  if (error instanceof InputPathError) {
    return new ApprovalsWriteError(error.message, { cause: error });
  }
  return new ApprovalsWriteError(
    `approvals store: cannot write file (${String((error as NodeJS.ErrnoException).code)})`,
    { cause: error },
  );
}

export async function decideRequest(
  path: string,
  input: {
    readonly requestId: string;
    readonly decision: "approved" | "rejected";
    readonly author: string;
    readonly now: () => Date;
  },
): Promise<DecideOutcome> {
  try {
    return await withFileLock("requests lock", path, async () => {
      const doc = await readApprovals(path);
      const index = doc.requests.findIndex((entry) => entry.requestId === input.requestId);
      if (index === -1) {
        return { kind: "refused", code: "unknown-request" };
      }
      const current = doc.requests[index] as ApprovalRequest;
      if (current.state !== "pending") {
        if (
          current.state === input.decision &&
          current.decision?.author === input.author
        ) {
          return { kind: "unchanged", request: current };
        }
        return { kind: "refused", code: "already-decided" };
      }
      const decided: ApprovalRequest = {
        ...current,
        state: input.decision,
        decision: {
          seq: doc.nextSeq,
          author: input.author,
          decidedAt: input.now().toISOString(),
        },
      };
      const next: ApprovalsDocument = {
        schemaVersion: "v1",
        nextSeq: doc.nextSeq + 1,
        requests: doc.requests.map((entry, position) => (position === index ? decided : entry)),
      };
      checkApprovals(next, path);
      try {
        await writeFileAtomic("approvals store", path, `${JSON.stringify(next)}\n`);
      } catch (error: unknown) {
        throw toWriteError(error);
      }
      return { kind: "decided", request: decided };
    });
  } catch (error: unknown) {
    if (error instanceof FileLockError) {
      if (error.code === "busy") {
        throw new ApprovalsBusyError(error.message, { cause: error });
      }
      if (error.code === "open-failed") {
        throw new ApprovalsDataError(error.message, { cause: error });
      }
      throw new ApprovalsWriteError(error.message, { cause: error });
    }
    throw error;
  }
}
