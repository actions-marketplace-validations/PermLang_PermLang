// `permlang diff`: what a change adds to or removes from the lock file, written
// for a pull-request comment (markdown) or a terminal (text). New access comes
// first, with the path to the line that causes it when that is known.

import type { DependencyChange } from "./deps.js";
import type { FunctionChange, LockDiff } from "./lock.js";

/** For each lock key, each capability's path: units on the way, then the call. */
export type ViaPaths = Record<string, Record<string, string[]>>;

/** Marks PermLang's comment so the GitHub Action updates it instead of adding another. */
export const COMMENT_MARKER = "<!-- permlang-diff -->";

/**
 * Whether the code reaches access the lock file doesn't record yet, which lock file, and the
 * packages the change adds (shown for review; they don't fail the check).
 */
export type DiffNotes = { unrecorded?: boolean; lockFile?: string; dependencies?: DependencyChange[]; aiTools?: Record<string, string[]> };

const KNOWN: Record<DependencyChange["known"], string> = {
  adapter: "Checked by an adapter",
  pure: "Declared pure",
  detected: "Detected directly",
  unknown: "**Not checked**: no adapter",
};

function unrecordedSentence(notes: DiffNotes, lock: string): string {
  return `This change reaches access that ${lock} doesn't record yet, so the check fails. To approve it, run \`permlang lock\` and commit ${lock}.`;
}

export function formatDiffMarkdown(diff: LockDiff, via: ViaPaths, notes: DiffNotes = {}): string {
  const lines = [COMMENT_MARKER, "### PermLang permission diff", ""];
  if (notes.unrecorded) {
    lines.push(`> [!WARNING]\n> **Not approved yet.** ${unrecordedSentence(notes, code(notes.lockFile ?? "permlang.lock.json"))}`, "");
  }
  const gaining = diff.functions.filter((f) => f.added.length > 0);
  const losing = diff.functions.filter((f) => f.removed.length > 0);

  if (gaining.length === 0 && losing.length === 0 && diff.unsafeAdded.length === 0 && diff.unsafeRemoved.length === 0) {
    lines.push("No permission changes.", "");
    lines.push(...dependencySection(notes.dependencies));
    return lines.join("\n").trimEnd();
  }

  const counts = [
    gaining.length > 0 ? `**${plural(gaining.length, "function")} ${gaining.length === 1 ? "gains" : "gain"} access**` : "",
    losing.length > 0 ? `${plural(losing.length, "function")} ${losing.length === 1 ? "loses" : "lose"} access` : "",
    diff.unsafeAdded.length > 0 ? `**${plural(diff.unsafeAdded.length, "new @perm-unsafe override")}**` : "",
  ].filter(Boolean);
  lines.push(counts.join(" · "), "");

  // One row per new capability: where it happens, then every function that can now reach it.
  // Propagation means one new call can add access to many callers; listing each separately buries it.
  if (gaining.length > 0) {
    lines.push("| New access | Where it happens | Now reachable from |", "| --- | --- | --- |");
    for (const [capability, functions] of byCapability(gaining)) {
      const origin = shortestPath(capability, functions, via);
      const where = origin ? `${code(origin.fn.name)}<br><sub>${text(origin.path.join(" → "))}</sub>` : "";
      const reachable = functions.map((f) => `${code(f.name)}${f.status === "added" ? " (new)" : ""}`).join(", ");
      // An AI model can trigger it: whoever controls the model's input can, too.
      const tools = [...new Set(notes.aiTools?.[capability] ?? [])];
      const byModel = tools.length > 0 ? `<br><sub>⚠️ An AI model can trigger this, through ${tools.map((t) => code(t)).join(", ")}</sub>` : "";
      lines.push(`| ${code(`+ ${capability}`)} | ${where} | ${reachable}${byModel} |`);
    }
    lines.push("");
  }

  if (diff.unsafeAdded.length > 0) {
    lines.push("**New <code>@perm-unsafe</code> overrides** (checks suppressed):", "");
    for (const u of diff.unsafeAdded) lines.push(`- ${code(u.key)}: ${text(u.reason)}`);
    lines.push("");
  }

  if (losing.length > 0 || diff.unsafeRemoved.length > 0) {
    lines.push("<details><summary>Removed access</summary>", "");
    for (const f of losing) lines.push(`- ${code(f.name)} (${text(f.file)}): ${f.removed.map((c) => code(`- ${c}`)).join(", ")}`);
    for (const u of diff.unsafeRemoved) lines.push(`- ${code(u.key)}: @perm-unsafe removed`);
    lines.push("", "</details>", "");
  }

  lines.push(...dependencySection(notes.dependencies));
  lines.push("<sub>Approving this change approves the access above. Details: `permlang check`.</sub>");
  return lines.join("\n");
}

/** New packages, with what PermLang knows about each and the scripts that run on install. */
function dependencySection(deps: readonly DependencyChange[] | undefined): string[] {
  if (!deps || deps.length === 0) return [];
  const heading = deps.length === 1 ? "1 new dependency" : `${deps.length} new dependencies`;
  const lines = [`**${heading}**`, "", "| Package | What PermLang sees | Install scripts |", "| --- | --- | --- |"];
  for (const d of deps) {
    const scripts = d.installScripts === undefined ? "<sub>not installed here</sub>" : d.installScripts.length === 0 ? "none" : d.installScripts.map((x) => code(x)).join("<br>");
    lines.push(`| ${code(`+ ${d.name}`)} ${text(d.version)}${d.dev ? " <sub>(dev)</sub>" : ""} | ${KNOWN[d.known]} | ${scripts} |`);
  }
  lines.push("");
  return lines;
}

export function formatDiffText(diff: LockDiff, via: ViaPaths, notes: DiffNotes = {}): string {
  const out: string[] = [];
  if (notes.unrecorded) out.push(`Not approved yet: ${unrecordedSentence(notes, notes.lockFile ?? "permlang.lock.json")}`);
  for (const f of diff.functions) {
    const head = `${f.file} ${f.name}${f.status === "added" ? " (new)" : f.status === "removed" ? " (removed)" : ""}`;
    const rows = [
      ...f.added.map((c) => `  + ${c}${via[f.key]?.[c] ? `  via ${via[f.key]![c]!.join(" → ")}` : ""}${notes.aiTools?.[c] ? `  (an AI model can trigger this: ${[...new Set(notes.aiTools[c])].join(", ")})` : ""}`),
      ...f.removed.map((c) => `  - ${c}`),
    ];
    out.push([head, ...rows].join("\n"));
  }
  for (const u of diff.unsafeAdded) out.push(`${u.key}\n  + @perm-unsafe: ${u.reason}`);
  for (const u of diff.unsafeRemoved) out.push(`${u.key}\n  - @perm-unsafe`);
  const changed = out.length > (notes.unrecorded ? 1 : 0);
  if (!changed) out.push("No permission changes.");
  if (notes.dependencies && notes.dependencies.length > 0) {
    const rows = notes.dependencies.map((d) => {
      const known = { adapter: "checked by an adapter", pure: "declared pure", detected: "detected directly", unknown: "not checked: no adapter" }[d.known];
      const scripts = d.installScripts === undefined ? "" : d.installScripts.length === 0 ? "" : `; install scripts: ${d.installScripts.join(", ")}`;
      return `  + ${d.name} ${d.version}${d.dev ? " (dev)" : ""}: ${known}${scripts}`;
    });
    out.push(["New dependencies", ...rows].join("\n"));
  }
  return out.join("\n\n");
}

function byCapability(changes: readonly FunctionChange[]): Map<string, FunctionChange[]> {
  const out = new Map<string, FunctionChange[]>();
  for (const f of changes) for (const c of f.added) out.set(c, [...(out.get(c) ?? []), f]);
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** The function closest to where a capability is used: the shortest known path wins. */
function shortestPath(capability: string, functions: readonly FunctionChange[], via: ViaPaths) {
  let best: { fn: FunctionChange; path: string[] } | undefined;
  for (const fn of functions) {
    const path = via[fn.key]?.[capability];
    if (path && (!best || path.length < best.path.length)) best = { fn, path };
  }
  return best;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Text that comes from code (capabilities, names, paths, reasons) is escaped for
 * both HTML and markdown. A capability like fs.read(/a` | |\n<!--) must not be able
 * to end a code span, split a table cell, or open an HTML comment that hides the
 * rows after it, because reviewers approve what the comment shows.
 */
function text(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("`", "&#96;")
    .replaceAll("|", "&#124;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("\\", "&#92;")
    .replace(/[\r\n]+/g, " ");
}

function code(value: string): string {
  return `<code>${text(value)}</code>`;
}
