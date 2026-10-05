// Project configuration: GitHub workflows, composite Actions, and package.json scripts.
// These grant as much as code does (a token with write access, a secret, a hook that
// runs on install), and AI agents edit them as readily as code. Each file is recorded
// in the lock like a function, with what it grants as its capabilities:
//
//   ci.trigger(pull_request_target)   an event the workflow runs on
//   ci.permission(contents: write)    a token permission; ci.permission(default) when unset
//   ci.secret(NPM_TOKEN)              a secret the workflow reads; ci.secret(inherit), ci.secret(all)
//   ci.action(actions/checkout)       an Action or reusable workflow it runs
//   ci.unpinned(actions/setup-node)   ...referenced by a tag or branch, not an exact commit
//   npm.script(postinstall: node x)   a package.json script and its command
//
// So a change that adds any of these fails the check until the lock records it, and
// shows in the pull-request comment, exactly like new access in code. Version bumps of
// pinned Actions don't change the lock; switching one to a tag does.
/**
 * @module
 * @perm fs.read
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Document, type Node as YamlNode, type Pair, type YAMLMap } from "yaml";
import type { FunctionReport } from "./check.js";

const SHA = /^[0-9a-f]{40}$/;

/** Every configuration file under `root` that PermLang records, as lock entries. */
export function projectFiles(root: string): FunctionReport[] {
  const out: FunctionReport[] = [];
  const workflows = path.join(root, ".github", "workflows");
  for (const file of listFiles(workflows, false).filter((f) => /\.ya?ml$/.test(f))) out.push(yamlEntry(file, "workflow"));
  for (const name of ["action.yml", "action.yaml"]) {
    const file = path.join(root, name);
    if (existsSync(file)) out.push(yamlEntry(file, "action"));
  }
  for (const file of listFiles(path.join(root, ".github", "actions"), true).filter((f) => /[\\/]action\.ya?ml$/.test(f))) {
    out.push(yamlEntry(file, "action"));
  }
  const pkg = path.join(root, "package.json");
  if (existsSync(pkg)) out.push(packageEntry(pkg));
  return out.filter((e) => e.actual.length > 0);
}

class Entry {
  readonly caps = new Map<string, { text: string; line: number; column: number }>();
  constructor(readonly file: string) {}

  add(capability: string, text: string, line: number, column: number) {
    if (!this.caps.has(capability)) this.caps.set(capability, { text, line, column });
  }

  report(): FunctionReport {
    const actual = [...this.caps.keys()].sort();
    return {
      file: path.resolve(this.file),
      name: `<${path.basename(this.file)}>`,
      line: 1,
      annotated: false,
      declared: [],
      actual,
      via: Object.fromEntries(actual.map((c) => [c, [this.caps.get(c)!.text]])),
      sites: Object.fromEntries(actual.map((c) => [c, { line: this.caps.get(c)!.line, column: this.caps.get(c)!.column }])),
      kind: "config",
    };
  }
}

// --- GitHub workflows and Actions ---------------------------------------------

function yamlEntry(file: string, kind: "workflow" | "action"): FunctionReport {
  const entry = new Entry(file);
  const text = readFileSync(file, "utf8");
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: false });
  // A file GitHub reads but PermLang can't: recorded, so it can't hide anything.
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    entry.add("ci.unverifiable", "a YAML file PermLang can't read", 1, 1);
    return entry.report();
  }
  const at = (node: YamlNode | Pair | null | undefined): { line: number; column: number } => {
    const range = (isPair(node) ? (node.key as YamlNode | null) : node)?.range;
    const { line, col } = lines.linePos(range?.[0] ?? 0);
    return { line, column: col };
  };
  const add = (capability: string, textOf: string, node: YamlNode | Pair | null | undefined) => {
    const { line, column } = at(node);
    entry.add(capability, textOf, line, column);
  };

  if (kind === "workflow") {
    triggers(doc, add);
    permissions(doc.contents, add);
  }
  usesAndSecrets(doc, add);
  return entry.report();
}

type Add = (capability: string, text: string, node: YamlNode | Pair | null | undefined) => void;

function triggers(doc: Document, add: Add) {
  const on = pair(doc.contents as YAMLMap, "on");
  const value = on?.value as YamlNode | null | undefined;
  if (isScalar(value)) {
    add(`ci.trigger(${value.value})`, `on: ${value.value}`, value);
  } else if (isSeq(value)) {
    for (const item of value.items) if (isScalar(item)) add(`ci.trigger(${item.value})`, `on: ${item.value}`, item);
  } else if (isMap(value)) {
    for (const p of value.items) if (isScalar(p.key)) add(`ci.trigger(${p.key.value})`, `on: ${p.key.value}`, p);
  }
}

/** Each job's token permissions: its own block, else the workflow's, else the repository default. */
function permissions(workflow: YAMLMap, add: Add) {
  const top = pair(workflow, "permissions");
  const jobs = pair(workflow, "jobs")?.value;
  if (!isMap(jobs)) return;
  for (const job of jobs.items) {
    const own = isMap(job.value) ? pair(job.value, "permissions") : undefined;
    const block = own ?? top;
    if (!block) {
      add("ci.permission(default)", "no permissions block: the token gets the repository's default, which can be write-all", job);
      continue;
    }
    const value = block.value as YamlNode | null;
    if (isScalar(value)) add(`ci.permission(${value.value})`, `permissions: ${value.value}`, value);
    else if (isMap(value)) {
      for (const p of value.items) {
        if (isScalar(p.key) && isScalar(p.value)) add(`ci.permission(${p.key.value}: ${p.value.value})`, `permissions: ${p.key.value}: ${p.value.value}`, p);
      }
    }
  }
}

/** Actions and reusable workflows (`uses:`), and secrets read anywhere in the file. */
function usesAndSecrets(doc: Document, add: Add) {
  visit(doc, {
    Pair(_, p) {
      if (!isScalar(p.key)) return;
      if (p.key.value === "uses" && isScalar(p.value) && typeof p.value.value === "string") {
        const uses = p.value.value.trim();
        const { name, pinned } = action(uses);
        add(`ci.action(${name})`, `uses: ${uses}`, p);
        if (!pinned) add(`ci.unpinned(${name})`, `uses: ${uses}`, p);
      }
      if (p.key.value === "secrets" && isScalar(p.value) && p.value.value === "inherit") add("ci.secret(inherit)", "secrets: inherit", p);
    },
    Scalar(_, node) {
      if (typeof node.value !== "string" || !node.value.includes("secrets")) return;
      for (const m of node.value.matchAll(/\bsecrets\.([A-Za-z_][\w-]*)|\bsecrets\[\s*['"]([^'"]+)['"]\s*\]/g)) {
        const name = m[1] ?? m[2]!;
        add(`ci.secret(${name})`, m[0], node);
      }
      // Every secret at once: toJSON(secrets), or secrets passed whole.
      if (/\btoJSON\(\s*secrets\s*\)|\$\{\{\s*secrets\s*\}\}/.test(node.value)) add("ci.secret(all)", node.value.trim(), node);
    },
  });
}

/** `owner/repo/path@ref` → its name, and whether ref is an exact commit; `./local` is always pinned. */
function action(uses: string): { name: string; pinned: boolean } {
  if (uses.startsWith("./")) return { name: uses, pinned: true };
  if (uses.startsWith("docker://")) {
    const image = uses.slice("docker://".length);
    return { name: `docker://${image.split("@")[0]!.split(":")[0]}`, pinned: /@sha256:[0-9a-f]{64}$/.test(image) };
  }
  const at = uses.lastIndexOf("@");
  if (at === -1) return { name: uses, pinned: false };
  return { name: uses.slice(0, at), pinned: SHA.test(uses.slice(at + 1)) };
}

function pair(map: YAMLMap, key: string): Pair<YamlNode, YamlNode | null> | undefined {
  return map.items.find((p) => isScalar(p.key) && p.key.value === key) as Pair<YamlNode, YamlNode | null> | undefined;
}

// --- package.json -------------------------------------------------------------

function packageEntry(file: string): FunctionReport {
  const entry = new Entry(file);
  const text = readFileSync(file, "utf8");
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(text) as { scripts?: unknown };
    scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? (pkg.scripts as Record<string, unknown>) : {};
  } catch {
    entry.add("npm.unverifiable", "a package.json PermLang can't read", 1, 1);
    return entry.report();
  }
  const from = Math.max(0, text.indexOf('"scripts"'));
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    const key = text.indexOf(`${JSON.stringify(name)}`, from);
    const before = text.slice(0, Math.max(0, key));
    const line = before.split("\n").length;
    const column = key - (before.lastIndexOf("\n") + 1) + 1;
    entry.add(`npm.script(${name}: ${command})`, `"${name}": ${JSON.stringify(command)}`, line, column);
  }
  return entry.report();
}

function listFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive, encoding: "utf8" })
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile())
    .sort();
}
