import { expect, test } from "bun:test";
import { sum } from "../src/sum.ts";

test("sum adds two numbers", () => {
  expect(sum(2, 3)).toBe(5);
});
