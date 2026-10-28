// Lock holder case: holds the loop state lock while the test checks the
// busy path, then exits. Run as a child process (see state.test.ts L5).
import { withFileLock } from "../../src/fs/lock.js";

const target = process.env["LOOP_STATE_TEST_PATH"] ?? "";
await withFileLock("loop state lock", target, async () => {
  console.log("holder ready");
  await new Promise(() => {});
});
