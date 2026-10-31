// Worker body for the boundary probe: tries the approvals decide module and
// posts "loaded" or the refusal message.
import { fileURLToPath } from "node:url";

const decidePath = fileURLToPath(new URL("../../../../src/approvals/decide.ts", import.meta.url));

// eslint-disable-next-line no-restricted-syntax -- the form under test
import(decidePath).then(
  () => {
    postMessage("loaded");
  },
  (error: unknown) => {
    postMessage(error instanceof Error ? error.message : String(error));
  },
);
