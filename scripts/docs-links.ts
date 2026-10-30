import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";

interface BrokenLink {
  file: string;
  line: number;
  target: string;
}

function parseRootArg(): string {
  const args = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        process.stderr.write("docs:links: missing value for --root\n");
        process.exit(2);
      }
      root = next;
      i++;
    } else if (arg) {
      process.stderr.write(`docs:links: unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return root;
}

function isUrlScheme(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

export function checkRoot(root: string): BrokenLink[] {
  const broken: BrokenLink[] = [];

  const files: string[] = [];
  const readme = join(root, "README.md");
  const agents = join(root, "AGENTS.md");
  if (existsSync(readme)) files.push(readme);
  if (existsSync(agents)) files.push(agents);

  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) {
    const entries = readdirSync(docsDir);
    for (const entry of entries) {
      const full = join(docsDir, entry);
      try {
        if (statSync(full).isFile() && entry.endsWith(".md")) {
          files.push(full);
        }
      } catch {
        // ignore entries that cannot be statted
      }
    }
  }

  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    let inCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmedStart = line.trimStart();
      if (trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      linkRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = linkRegex.exec(line)) !== null) {
        const targetRaw = (match[2] ?? "").trim();
        if (!targetRaw) continue;
        const targetWithoutTitle = targetRaw.split(/\s+/)[0] ?? "";
        if (!targetWithoutTitle) continue;
        if (targetWithoutTitle.startsWith("#")) continue;
        if (isUrlScheme(targetWithoutTitle)) continue;
        if (targetWithoutTitle.startsWith("/")) continue;

        const targetNoFrag = targetWithoutTitle.split("#")[0];
        if (!targetNoFrag) continue;

        const resolvedPath = resolve(dirname(filePath), targetNoFrag);

        if (!existsSync(resolvedPath)) {
          const relFile = relative(root, filePath);
          broken.push({
            file: relFile.replace(/\\/g, "/"),
            line: i + 1,
            target: targetNoFrag,
          });
        }
      }
    }
  }

  return broken;
}

if (import.meta.main) {
  const root = parseRootArg();
  const broken = checkRoot(root);
  for (const b of broken) {
    console.log(`${b.file}:${String(b.line)}: ${b.target}`);
  }
  process.exit(broken.length > 0 ? 1 : 0);
}
