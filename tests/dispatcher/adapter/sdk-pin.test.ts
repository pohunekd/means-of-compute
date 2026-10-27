// SDK pin test (design section 1): the dependency URL and the bun.lock
// integrity strings pin the exact tarball bytes on a cold cache. The test
// spells only URLs and digests, never the package specifier text.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GITHUB_RELEASES = "https://github.com/zajca/pohunek/releases/download/v0.37.0";
const SDK_URL = `${GITHUB_RELEASES}/pohunek-ts-sdk-0.37.0.tgz`;
const PROTOCOL_URL = `${GITHUB_RELEASES}/pohunek-ts-protocol-0.37.0.tgz`;
const SDK_DIGEST =
  "sha512-aVKD4DE+8AYBzdfmseqF6LwCdB24jf7OOoiK9wlWRO69087gEhf6rxypQo8EksuVSkYCn3ROfLgfyIVc9P1FUA==";
const PROTOCOL_DIGEST =
  "sha512-VCQw2goZf8rcGZRZrZuiFo5mn+z7ZbHoewDuJKiUu79+G6RYaISYGWttJ2s9R/NFzLpqC7zxNmHQFxZ7XOG81w==";
const AT = "@";

async function repoFile(name: string): Promise<string> {
  return readFile(join(process.cwd(), name), "utf8");
}

function lockLineFor(text: string, url: string, digest: string): string | undefined {
  const needle = `${AT}${url}"`;
  const suffix = `"${digest}"],`;
  for (const line of text.split("\n")) {
    if (line.includes(needle) && line.trimEnd().endsWith(suffix)) {
      return line;
    }
  }
  return undefined;
}

test("package.json pins exactly one dependency to the SDK release URL", async () => {
  const parsed: unknown = JSON.parse(await repoFile("package.json")) as unknown;
  const dependencies = (parsed as { dependencies: Record<string, string> }).dependencies;
  const matches = Object.values(dependencies).filter((value) => value === SDK_URL);
  expect(matches).toHaveLength(1);
});

test("bun.lock pins the SDK tarball integrity", async () => {
  const text = await repoFile("bun.lock");
  expect(lockLineFor(text, SDK_URL, SDK_DIGEST)).toBeDefined();
});

test("bun.lock pins the protocol tarball integrity", async () => {
  const text = await repoFile("bun.lock");
  expect(lockLineFor(text, PROTOCOL_URL, PROTOCOL_DIGEST)).toBeDefined();
});
