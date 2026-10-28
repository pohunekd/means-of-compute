// Dashboard HTML builder tests. The escaping contract of design 2.6 holds:
// the only markup factory is the html tag, and no public raw wrapper lets a
// later change smuggle unescaped text past the type checker.
import { describe, expect, test } from "bun:test";
import { constantHtml, escapeHtml, html, SafeHtml } from "../../src/dashboard/html.js";

describe("dashboard html factory (mutation: public raw wrapper restored)", () => {
  test("SafeHtml exposes no static raw factory", () => {
    expect((SafeHtml as unknown as Record<string, unknown>)["raw"]).toBeUndefined();
    expect(typeof (SafeHtml as unknown as Record<string, unknown>)["create"]).toBe("function");
  });

  test("the tag escapes interpolations and passes constants through", () => {
    expect(html`<p>${"<b>&"}</p>`.value).toBe("<p>&lt;b&gt;&amp;</p>");
    expect(escapeHtml(`<a href="x">'`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;");
    expect(constantHtml("<b>ok</b>").value).toBe("<b>ok</b>");
  });
});
