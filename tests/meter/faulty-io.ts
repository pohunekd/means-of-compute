// Faulty usage-log IO for latch tests: writes fail when failWhen matches,
// which latches the meter. Reads and real writes go through the system IO.
import { systemUsageLogIo, type UsageLogIo } from "../../src/meter/usage-log.js";

export function createFaultyIo(failWhen: (line: string) => boolean): UsageLogIo {
  return {
    async open(path: string) {
      const real = await systemUsageLogIo.open(path);
      return {
        async write(text: string): Promise<void> {
          if (failWhen(text)) {
            throw new Error("injected write failure");
          }
          await real.write(text);
        },
        async datasync(): Promise<void> {
          await real.datasync();
        },
        async close(): Promise<void> {
          await real.close();
        },
      };
    },
  };
}
