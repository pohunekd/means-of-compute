// Minimal HTML builder. The tagged template is the only markup factory:
// every string/number interpolation is escaped, SafeHtml passes through,
// and an array of SafeHtml joins with "". No other module concatenates markup.
// Brand key that never leaves this module. The static factory needs it,
// so no code outside this module can build a SafeHtml: markup flows only
// through the html tag or the constant-only helper below.
const trusted = Symbol("dashboard.trusted-html");
type Trusted = typeof trusted;

export class SafeHtml {
  readonly value: string;
  private readonly brand: Trusted;

  private constructor(value: string, brand: Trusted) {
    this.value = value;
    this.brand = brand;
  }

  static create(value: string, brand: Trusted): SafeHtml {
    return new SafeHtml(value, brand);
  }
}

function raw(value: string): SafeHtml {
  return SafeHtml.create(value, trusted);
}

// Constant-only helper for module-level string constants (the <style> body
// and empty markup). Never call it with dynamic data: interpolation through
// the html tag is the only path for runtime strings.
export function constantHtml(value: string): SafeHtml {
  return raw(value);
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
  return raw(out);
}
