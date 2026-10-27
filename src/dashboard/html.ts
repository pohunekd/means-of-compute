// Minimal HTML builder. The tagged template is the only markup factory:
// every string/number interpolation is escaped, SafeHtml passes through,
// and an array of SafeHtml joins with "". No other module concatenates markup.
export class SafeHtml {
  private constructor(readonly value: string) {}

  static raw(value: string): SafeHtml {
    return new SafeHtml(value);
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function html(
  strings: TemplateStringsArray,
  ...values: readonly (string | number | SafeHtml | readonly SafeHtml[])[]
): SafeHtml {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as string | number | SafeHtml | readonly SafeHtml[];
    if (typeof value === "string") {
      out += escapeHtml(value);
    } else if (typeof value === "number") {
      out += escapeHtml(String(value));
    } else if (value instanceof SafeHtml) {
      out += value.value;
    } else {
      out += value.map((entry) => entry.value).join("");
    }
    out += strings[index + 1] ?? "";
  }
  return SafeHtml.raw(out);
}
