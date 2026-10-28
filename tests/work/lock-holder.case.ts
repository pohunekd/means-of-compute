// Lock holder case: holds the work store lock while the test checks the
// busy path, then exits. Run as a child process (see store.test.ts S8).
import { withFileLock } from "../../src/fs/lock.js";

const target = process.env["WORK_STORE_TEST_PATH"] ?? "";
await withFileLock("work store lock", target, async () => {
  console.log("holder ready");
  await new Promise(() => {});
});
