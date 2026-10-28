// Faulty usage-log IO for latch tests: writes or datasyncs fail on demand,
// which latches the meter. Reads and real writes go through the system IO.
import { systemUsageLogIo, type UsageLogIo } from "../../src/meter/usage-log.js";

export interface FaultyIoOptions {
  readonly failWrite?: boolean;
  readonly failDatasync?: boolean;
  readonly failWhen?: (line: string) => boolean;
}

export function createFaultyIo(base: UsageLogIo, options: FaultyIoOptions): UsageLogIo {
  return {
    async open(path: string) {
      const real = await base.open(path);
      return {
        async write(text: string): Promise<void> {
          if (options.failWrite === true || options.failWhen?.(text) === true) {
            throw new Error("injected write failure");
          }
          await real.write(text);
        },
        async datasync(): Promise<void> {
          if (options.failDatasync === true) {
            throw new Error("injected datasync failure");
          }
          await real.datasync();
        },
        async close(): Promise<void> {
          await real.close();
        },
      };
    },
  };
}

export { systemUsageLogIo };
