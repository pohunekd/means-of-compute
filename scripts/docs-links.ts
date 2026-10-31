// docs:links: every relative Markdown link in README.md, AGENTS.md, SUBMISSION.md
// and every *.md under .agents/ and docs/ (any depth) must resolve to an existing path.
import { readFileSync, existsSync, readdirSync } from "fs";
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

const TOP_LEVEL_FILES = ["README.md", "AGENTS.md", "SUBMISSION.md"];
const DOC_DIRS = [".agents", "docs"];

// Symlinks are not followed: a Dirent for a symlink is neither a file nor a directory.
function markdownUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownUnder(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

export function checkRoot(root: string): BrokenLink[] {
  const broken: BrokenLink[] = [];

  const files: string[] = [];
  for (const name of TOP_LEVEL_FILES) {
    const full = join(root, name);
    if (existsSync(full)) files.push(full);
  }
  for (const name of DOC_DIRS) {
    const dir = join(root, name);
    if (existsSync(dir)) files.push(...markdownUnder(dir));
  }
  const relOf = (path: string): string => relative(root, path);
  files.sort((a, b) => (relOf(a) < relOf(b) ? -1 : relOf(a) > relOf(b) ? 1 : 0));

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
