// Dashboard HTML builder tests: string and number interpolations are
// escaped in text and attribute positions, and SafeHtml values and arrays
// pass through once without a second escape. Deterministic: no clock, no I/O.
import { expect, test } from "bun:test";
import { html } from "../../src/dashboard/html.js";

test("string and number interpolations are escaped", () => {
  const out = html`<p title="${'x" onclick="y'}">${"<script>&'"} ${42}</p>`;
  expect(out.value).toBe('<p title="x&quot; onclick=&quot;y">&lt;script&gt;&amp;&#39; 42</p>');
});

test("SafeHtml and arrays of SafeHtml pass through without a second escape", () => {
  const cell = html`<b>${"a&b"}</b>`;
  const out = html`<div>${cell}${[cell, cell]}${[]}</div>`;
  expect(out.value).toBe("<div><b>a&amp;b</b><b>a&amp;b</b><b>a&amp;b</b></div>");
});
