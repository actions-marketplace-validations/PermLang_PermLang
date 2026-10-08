// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// `permlang diff`: what a change adds to or removes from the lock file, written
// for a pull-request comment (markdown) or a terminal (text). New access comes
// first, with the path to the line that causes it when that is known. Anything
// that makes the diff incomplete (code that couldn't be analyzed, a deleted lock,
// a lock that doesn't match the code) is said at the top, never left out.

import { isOtherSource, type DependencyChange } from "./deps.js";
import { isConfigKey, type FunctionChange, type LockDiff } from "./lock.js";
import { printable } from "./report.js";
import { isSetting, isSingleValued, settingKind, value as settingValue } from "./settings.js";
import { isUncheckedKey, uncheckedCode, uncheckedWhat } from "./unchecked.js";

/** For each lock key, each capability's path: units on the way, then the call. */
export type ViaPaths = Record<string, Record<string, string[]>>;

/** Marks PermLang's comment so the GitHub Action updates it instead of adding another. */
export const COMMENT_MARKER = "<!-- permlang-diff -->";

/**
 * The marker for a run in `folder` (relative to the repository root), so that several runs on
 * one pull request, one per package of a monorepo, each keep their own comment.
 */
export function commentMarker(folder: string): string {
  // Only "." itself, or a leading "./", means nothing: `.web` is a folder of its own, not `web`.
  const f = folder.replaceAll("\\", "/").replace(/\/+$/, "").replace(/^\.(\/|$)/, "");
  if (f === "") return COMMENT_MARKER;
  // Encoded, so the folder's name can't end the HTML comment.
  return `<!-- permlang-diff: ${encodeURIComponent(f).replaceAll("%2F", "/").replaceAll("-", "%2D")} -->`;
}

/**
 * GitHub rejects a comment longer than 65,536 characters, and the Action would leave the old one
 * standing. This limit is in UTF-8 bytes, which are never fewer than characters, with room to spare.
 */
export const COMMENT_LIMIT = 60_000;

/** GitHub takes at most 1 MiB of job summary from a step, and shows an error instead of more. */
export const SUMMARY_LIMIT = 1_000_000;

/** The last line of the notice for a pull request with no lock file: see formatNoLock(). */
export const NO_LOCK_STATUS = "<!-- permlang-status: no-lock -->";

/** What the diff can't show by comparing locks alone. */
export interface DiffNotes {
  /** Where the code and the working tree's lock differ, which the check fails on until `permlang lock` is run. */
  pending?: LockDiff;
  /** False when the check doesn't compare with the lock (--no-lock), so pending changes don't fail it. */
  enforced?: boolean;
  lockFile?: string;
  /** The working tree has no lock, but the base commit has one. */
  lockDeleted?: boolean;
  /** Lock files the base commit's workflows check with that this change no longer reads (from the repository root). */
  lockMoved?: string[];
  /** The working tree's lock is in an older format: the check fails until `permlang lock` updates it. */
  lockOutdated?: boolean;
  /** The base commit has no lock, so everything is new. */
  baseMissing?: boolean;
  /** The base commit's lock is in an older format, which didn't record settings. */
  baseOutdated?: boolean;
  /** Why the code couldn't be analyzed. The diff then shows the lock files alone. */
  analysisError?: string;
  /** Packages the change adds, or now installs from another source (shown for review; they don't fail the check). */
  dependencies?: DependencyChange[];
  /** For each capability, the AI tools that can trigger it. */
  aiTools?: Record<string, string[]>;
  /** The comment's marker; see commentMarker(). */
  marker?: string;
}

const KNOWN: Record<DependencyChange["known"], string> = {
  adapter: "Checked by an adapter",
  pure: "Declared pure",
  detected: "Detected directly",
  unknown: "**Not checked**: no adapter",
};

const SECTION: Record<DependencyChange["section"], string> = {
  dependencies: "",
  devDependencies: "dev",
  optionalDependencies: "optional",
  peerDependencies: "peer",
  overrides: "overrides",
  resolutions: "resolutions",
  "pnpm.overrides": "pnpm.overrides",
};

/** At most this many functions are named in one table cell. */
const MAX_NAMED = 20;

// --- markdown ----------------------------------------------------------------

/** A run of comment lines; when the comment is cut short, rows are dropped from the end and the tail kept. */
interface Block {
  head: string[];
  rows?: string[];
  tail?: string[];
}

export function formatDiffMarkdown(diff: LockDiff, via: ViaPaths, notes: DiffNotes = {}, limit = COMMENT_LIMIT): string {
  const lock = code(notes.lockFile ?? "permlang.lock.json");
  const { settings, access, unchecked } = split(diff);
  const gaining = access.filter((f) => f.added.length > 0);
  const losing = access.filter((f) => f.removed.length > 0);
  const preapproved = lockOnly(notes);
  const uncheckedNew = unchecked.flatMap((f) => f.added);
  const uncheckedGone = unchecked.flatMap((f) => f.removed);
  const changed = gaining.length + losing.length + settings.length + unchecked.length + diff.unsafeAdded.length + diff.unsafeRemoved.length + diff.unsafeChanged.length > 0;

  const top = [notes.marker ?? COMMENT_MARKER, "### PermLang permission diff", ""];
  for (const alert of alerts(notes, lock)) top.push(alert, "");
  if (notes.baseMissing) top.push(`<sub>There's no ${lock} at the base commit, so everything is listed as new.</sub>`, "");
  if (notes.baseOutdated) top.push(`<sub>The base commit's ${lock} was written by an older PermLang, which didn't record check settings, so they're listed as new.</sub>`, "");
  if (!changed) {
    // Only a complete diff, of code that matches its lock, can say that nothing changed.
    const complete = !notes.analysisError && !notes.lockDeleted && !notes.lockOutdated && !pendingChanges(notes);
    // Dependencies don't change what the lock records, but they can change what the code runs.
    const changedDeps = (notes.dependencies ?? []).length > 0 ? " The dependencies changed, though: review them below." : "";
    top.push(complete ? `No permission changes.${changedDeps}` : notes.analysisError ? "The lock files show no permission changes, but the code wasn't analyzed." : "The base and the code reach the same access.", "");
  } else {
    const counts = [
      gaining.length > 0 ? `**${plural(gaining.length, "function")} ${gaining.length === 1 ? "gains" : "gain"} access**` : "",
      losing.length > 0 ? `${plural(losing.length, "function")} ${losing.length === 1 ? "loses" : "lose"} access` : "",
      settings.length > 0 ? "**Check settings changed**" : "",
      uncheckedNew.length > 0 ? "**New code PermLang can't check**" : "",
      uncheckedGone.length > 0 && uncheckedNew.length === 0 ? "Less code PermLang can't check" : "",
      diff.unsafeAdded.length > 0 ? `**${plural(diff.unsafeAdded.length, "new <code>@perm-unsafe</code> override")}**` : "",
      diff.unsafeChanged.length > 0 ? `**${plural(diff.unsafeChanged.length, "changed <code>@perm-unsafe</code> reason")}**` : "",
      diff.unsafeRemoved.length > 0 ? plural(diff.unsafeRemoved.length, "removed <code>@perm-unsafe</code> override") : "",
    ].filter(Boolean);
    // A summary that only names the one section right below it would say the same thing twice.
    const onlyNamesItsSection = counts.length === 1 && (counts[0] === "**Check settings changed**" || counts[0] === "**New code PermLang can't check**");
    if (!onlyNamesItsSection) top.push(counts.join(" · "), "");
  }
  const blocks: Block[] = [{ head: top }];

  // One row per new capability: where it happens, then every function that can now reach it.
  // Propagation means one new call can add access to many callers; listing each separately buries it.
  // First after the alerts, since it's what approving the change approves: no other section can
  // push it out of a comment that's cut short.
  if (gaining.length > 0) {
    const rows: string[] = [];
    for (const [capability, functions] of byCapability(gaining)) {
      const origin = shortestPath(capability, functions, via);
      const where = origin ? `${code(origin.fn.name)}<br><sub>${plain(origin.path.join(" → "))}</sub>` : "";
      const named = listed(functions.map((f) => `${code(f.name)}${f.status === "added" ? " (new)" : ""}`));
      // An AI model can trigger it: whoever controls the model's input can, too.
      const tools = [...new Set(own(notes.aiTools, capability) ?? [])];
      const byModel = tools.length > 0 ? `<br><sub>⚠️ An AI model can trigger this, through ${listed(tools.map((t) => code(t)))}</sub>` : "";
      rows.push(`| ${code(`+ ${capability}`)} | ${where} | ${named}${byModel} |`);
    }
    blocks.push({ head: ["| New access | Where it happens | Now reachable from |", "| --- | --- | --- |"], rows, tail: [""] });
  }

  if (uncheckedNew.length > 0) {
    blocks.push({
      head: ["**New code PermLang can't check.** It has no types, or no adapter, so what it does isn't in this diff: review it.", ""],
      rows: uncheckedNew.map((c) => `- ${code(`+ ${uncheckedCode(c).target}`)}: ${uncheckedWhat(c)}${plain(uncheckedAt(c, via))}`),
      tail: [""],
    });
  }

  if (settings.length > 0) {
    blocks.push({ head: ["**Check settings changed.** These change what PermLang checks, or how strictly:", ""], rows: settingRows(settings, via), tail: [""] });
  }

  if (diff.unsafeAdded.length > 0 || diff.unsafeChanged.length > 0) {
    const rows = [
      ...diff.unsafeAdded.map((u) => `- ${code(u.key)}: ${plain(u.reason)}`),
      ...diff.unsafeChanged.map((u) => `- ${code(u.key)}: ${plain(u.after)} <sub>(was: ${plain(u.before)})</sub>`),
    ];
    blocks.push({ head: ["**New or changed <code>@perm-unsafe</code> overrides** (checks suppressed):", ""], rows, tail: [""] });
  }

  if (preapproved.length > 0) {
    blocks.push({
      head: [`**Access ${lock} records, but the code doesn't reach.** A lock can't approve access in advance: the check fails until \`permlang lock\` removes it.`, ""],
      rows: preapproved.map((p) => `- ${code(p.name)} (${plain(p.file)}): ${listed(p.removed.map((c) => code(`- ${c}`)))}`),
      tail: [""],
    });
  }

  const deps = notes.dependencies ?? [];
  if (deps.length > 0) {
    blocks.push({ head: [`**${dependencyHeading(deps)}**`, "", "| Package | What PermLang sees | Install scripts |", "| --- | --- | --- |"], rows: deps.map(dependencyRow), tail: [""] });
  }

  if (losing.length > 0 || diff.unsafeRemoved.length > 0 || uncheckedGone.length > 0) {
    blocks.push({
      head: ["<details><summary>Removed access</summary>", ""],
      rows: [
        ...losing.map((f) => `- ${code(f.name)} (${plain(f.file)}): ${listed(f.removed.map((c) => code(`- ${c}`)))}`),
        ...diff.unsafeRemoved.map((u) => `- ${code(u.key)}: <code>@perm-unsafe</code> removed`),
        ...uncheckedGone.map((c) => `- ${code(`- ${uncheckedCode(c).target}`)}: no longer ${uncheckedWhat(c)}`),
      ],
      tail: ["", "</details>", ""],
    });
  }

  const footer = changed || preapproved.length > 0 ? ["<sub>Approving this change approves the access above. Details: `permlang check`.</sub>"] : [];
  return fit(blocks, footer, limit).trimEnd();
}

/**
 * The comment when the diff can't be computed at all, such as when the base commit can't be read.
 * The Action posts it over the previous comment, which would otherwise look current.
 */
export function formatDiffFailure(reason: string, marker = COMMENT_MARKER): string {
  return [
    marker,
    "### PermLang permission diff",
    "",
    `> [!CAUTION]\n> **PermLang couldn't compute the permission diff** for the latest push, so an earlier version of this comment no longer applies. The job log has the details: ${plain(reason, 2000)}`,
  ].join("\n");
}

/**
 * The comment when there's no lock file in the pull request or at its base commit, so nothing to
 * compare. The Action posts it only over its own earlier comment, which would otherwise go on
 * showing a diff that no longer applies; its last line tells the Action which kind it is.
 */
export function formatNoLock(lockFile: string, marker = COMMENT_MARKER): string {
  return [
    marker,
    "### PermLang permission diff",
    "",
    `There's no ${code(lockFile)} in this pull request or at its base commit, so there's no permission diff, and new access doesn't fail the check. Run \`permlang lock\` and commit ${code(lockFile)} to get one.`,
    "",
    NO_LOCK_STATUS,
  ].join("\n");
}

/** The warnings at the top of the comment: whatever makes the diff incomplete, or the check fail. */
function alerts(notes: DiffNotes, lock: string): string[] {
  const out: string[] = [];
  if (notes.analysisError) {
    out.push(
      `> [!CAUTION]\n> **PermLang couldn't analyze the code**, so this shows only what the lock files record, not what the code does. The check can't pass until this is fixed: ${plain(notes.analysisError, 2000)}`,
    );
  }
  if (notes.lockDeleted) {
    out.push(
      `> [!CAUTION]\n> **This pull request deletes ${lock}**, which PermLang compares the code with. Without it, new access can't be told from old. The PermLang Action fails the check until it's restored, or regenerated with \`permlang lock\` and committed.`,
    );
  }
  if (notes.lockMoved && notes.lockMoved.length > 0) {
    const instead = notes.enforced === false ? "" : `, and reads ${lock} instead`;
    out.push(
      `> [!CAUTION]\n> **This pull request stops checking with ${listed(notes.lockMoved.map((l) => code(l)))}**, which the base commit's workflow checks with${instead}. A lock file the base doesn't check with can approve whatever the change adds, so the PermLang Action fails the check until the workflow checks with the base's lock file again.`,
    );
  }
  if (notes.lockOutdated) {
    out.push(`> [!WARNING]\n> **${lock} was written by an older PermLang.** The check fails until \`permlang lock\` updates it, and the change is committed.`);
  } else if (pendingChanges(notes)) {
    const fails = notes.enforced === false ? "" : ", so the check fails";
    out.push(`> [!WARNING]\n> **Not approved yet.** The code and ${lock} don't match${fails}. To approve this change, run \`permlang lock\` and commit ${lock}.`);
  }
  return out;
}

const SETTING_LABEL: Record<string, string> = { project: "checked files", files: "checked files", imported: "imported by the checked files", flow: "flow rule" };

/** Settings changes, one row per value; a setting with one value that changed reads "now X, was Y". */
function settingRows(changes: readonly FunctionChange[], via: ViaPaths): string[] {
  const rows: string[] = [];
  for (const change of changes) {
    const label = (c: string) => (c.startsWith("tsconfig.") ? `${code(change.file)} ${settingKind(c).replace(/^tsconfig\./, "")}` : (SETTING_LABEL[settingKind(c)] ?? settingKind(c)));
    const shown = (c: string) => (settingKind(c) === "project" ? `--project ${settingValue(c)}` : settingValue(c));
    const from = (c: string) => {
      const source = own(own(via, change.key), c)?.[0];
      return source?.startsWith("--") ? ` <sub>(from ${code(source)})</sub>` : "";
    };
    const removed = [...change.removed];
    for (const c of change.added) {
      const old = isSingleValued(c) ? removed.find((o) => settingKind(o) === settingKind(c)) : undefined;
      if (old) {
        removed.splice(removed.indexOf(old), 1);
        rows.push(`- ${label(c)}: now ${code(shown(c))}, was ${code(shown(old))}${from(c)}`);
      } else {
        rows.push(`- ${label(c)}: ${code(`+ ${shown(c)}`)}${from(c)}`);
      }
    }
    for (const c of removed) rows.push(`- ${label(c)}: ${code(`- ${shown(c)}`)}`);
  }
  return rows;
}

/**
 * A new package, one now installed from another source, or a new or changed override, with what
 * PermLang knows about it and the scripts that run on install.
 */
function dependencyRow(d: DependencyChange): string {
  const scripts = d.installScripts === undefined ? "<sub>not installed here</sub>" : d.installScripts.length === 0 ? "none" : d.installScripts.map((x) => code(x)).join("<br>");
  const section = SECTION[d.section] ? ` <sub>(${SECTION[d.section]})</sub>` : "";
  if (d.change === "override") {
    const was = d.previous === undefined ? "" : `${plain(d.previous)} `;
    const sees = isOtherSource(d.version)
      ? `**Now installed from another source**, by an override: an adapter for ${code(d.target!)} may not describe this code`
      : `**Overridden**: installed at this version wherever ${code(d.target!)} is in the dependency tree`;
    return `| ${code(`~ ${d.name}`)} ${was}→ ${plain(d.version)}${section} | ${sees} | ${scripts} |`;
  }
  if (d.change === "source") {
    return `| ${code(`~ ${d.name}`)} ${plain(d.previous!)} → ${plain(d.version)}${section} | **Now installed from another source**: an adapter for ${code(d.name)} may not describe this code | ${scripts} |`;
  }
  return `| ${code(`+ ${d.name}`)} ${plain(d.version)}${section} | ${KNOWN[d.known]} | ${scripts} |`;
}

function dependencyHeading(deps: readonly DependencyChange[]): string {
  const count = (change: DependencyChange["change"]) => deps.filter((d) => d.change === change).length;
  const [added, moved, overridden] = [count("added"), count("source"), count("override")];
  const parts = [
    added > 0 ? plural(added, "new dependency", "new dependencies") : "",
    moved > 0 ? `${plural(moved, "dependency", "dependencies")} from another source` : "",
    overridden > 0 ? plural(overridden, "changed override") : "",
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * Joins the blocks, keeping the text under `limit` UTF-8 bytes. Blocks come in order of
 * importance, and each takes what room is left. A row that doesn't fit is left out, but later,
 * shorter ones still go in, so one long row can't take the place of all the others; a block is
 * left out whole when its heading doesn't fit, or none of its rows do. A note says how many
 * lines are left out, and where to see them.
 */
function fit(blocks: readonly Block[], footer: readonly string[], limit: number): string {
  const size = (lines: readonly string[]) => lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  const summary = limit > COMMENT_LIMIT;
  const note = (n: number) => [
    `> [!NOTE]\n> **Cut short** to fit GitHub's limit on ${summary ? "job summary size" : "comment length"}: ${plural(n, "more line")} ${n === 1 ? "isn't" : "aren't"} shown. ${summary ? "`permlang diff` prints the full diff." : "The job summary has the full diff, and `permlang diff` prints it."}`,
    "",
  ];
  const reserve = size(footer) + size(note(Number.MAX_SAFE_INTEGER));
  const out: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const block of blocks) {
    const rows = block.rows ?? [];
    const tail = block.tail ?? [];
    let room = limit - reserve - used - size(block.head) - size(tail);
    const kept: string[] = [];
    for (const row of rows) {
      if (size([row]) > room) continue;
      kept.push(row);
      room -= size([row]);
    }
    // A heading with none of its rows under it would say nothing.
    if (room < 0 || (rows.length > 0 && kept.length === 0)) {
      dropped += block.head.length + rows.length;
      continue;
    }
    dropped += rows.length - kept.length;
    out.push(...block.head, ...kept, ...tail);
    used += size(block.head) + size(kept) + size(tail);
  }
  return [...out, ...(dropped > 0 ? note(dropped) : []), ...footer].join("\n");
}

// --- text --------------------------------------------------------------------

export function formatDiffText(diff: LockDiff, via: ViaPaths, notes: DiffNotes = {}): string {
  const lock = notes.lockFile ?? "permlang.lock.json";
  const out: string[] = [];
  if (notes.analysisError) out.push(`Couldn't analyze the code, so this shows only what the lock files record: ${printable(notes.analysisError)}`);
  if (notes.lockDeleted) {
    out.push(`This change deletes ${lock}, which PermLang compares the code with. With --require-lock (as the Action runs it), the check fails until it's restored or regenerated.`);
  }
  if (notes.lockMoved && notes.lockMoved.length > 0) {
    const instead = notes.enforced === false ? "" : `, and reads ${lock} instead`;
    out.push(`This change stops checking with ${notes.lockMoved.map(printable).join(", ")}, which the base commit's workflow checks with${instead}. With --base (as the Action runs it), the check fails until the workflow checks with the base's lock file again.`);
  }
  if (notes.lockOutdated) out.push(`${lock} was written by an older PermLang: the check fails until \`permlang lock\` updates it.`);
  else if (pendingChanges(notes)) {
    out.push(`Not approved yet: the code and ${lock} don't match${notes.enforced === false ? "" : ", so the check fails"}. To approve this change, run \`permlang lock\` and commit ${lock}.`);
  }
  if (notes.baseMissing) out.push(`There's no ${lock} at the base commit, so everything is listed as new.`);
  const header = out.length;

  const { settings, access, unchecked } = split(diff);
  if (settings.length > 0) {
    const rows = settings.flatMap((s) => [...s.added.map((c) => `  + ${printable(s.file)}: ${printable(c)}`), ...s.removed.map((c) => `  - ${printable(s.file)}: ${printable(c)}`)]);
    out.push(["Check settings changed:", ...rows].join("\n"));
  }
  if (unchecked.length > 0) {
    const rows = unchecked.flatMap((f) => [
      ...f.added.map((c) => `  + ${printable(uncheckedCode(c).target)}: ${uncheckedWhat(c)}${printable(uncheckedAt(c, via))}`),
      ...f.removed.map((c) => `  - ${printable(uncheckedCode(c).target)}: no longer ${uncheckedWhat(c)}`),
    ]);
    out.push(["New code PermLang can't check:", ...rows].join("\n"));
  }
  for (const f of access) {
    const head = `${printable(f.file)} ${printable(f.name)}${f.status === "added" ? " (new)" : f.status === "removed" ? " (removed)" : ""}`;
    const rows = [
      ...f.added.map((c) => {
        const path = own(own(via, f.key), c);
        const tools = own(notes.aiTools, c);
        return `  + ${printable(c)}${path ? `  via ${printable(path.join(" → "))}` : ""}${tools ? `  (an AI model can trigger this: ${printable([...new Set(tools)].join(", "))})` : ""}`;
      }),
      ...f.removed.map((c) => `  - ${printable(c)}`),
    ];
    out.push([head, ...rows].join("\n"));
  }
  for (const u of diff.unsafeAdded) out.push(`${printable(u.key)}\n  + @perm-unsafe: ${printable(u.reason)}`);
  for (const u of diff.unsafeChanged) out.push(`${printable(u.key)}\n  ~ @perm-unsafe: ${printable(u.after)} (was: ${printable(u.before)})`);
  for (const u of diff.unsafeRemoved) out.push(`${printable(u.key)}\n  - @perm-unsafe`);
  const preapproved = lockOnly(notes);
  if (preapproved.length > 0) {
    const rows = preapproved.map((p) => `  ${printable(p.file)} ${printable(p.name)}: ${p.removed.map(printable).join(", ")}`);
    out.push([`Recorded in ${lock}, but the code doesn't reach it (the check fails until \`permlang lock\` removes it):`, ...rows].join("\n"));
  }
  if (out.length === header) {
    const complete = !notes.analysisError && !notes.lockDeleted && !notes.lockOutdated && !pendingChanges(notes);
    const changedDeps = (notes.dependencies ?? []).length > 0 ? " The dependencies changed, though: review them below." : "";
    out.push(complete ? `No permission changes.${changedDeps}` : notes.analysisError ? "The lock files show no permission changes, but the code wasn't analyzed." : "The base and the code reach the same access.");
  }
  const deps = notes.dependencies ?? [];
  if (deps.length > 0) {
    const rows = deps.map((d) => {
      const section = SECTION[d.section] ? ` (${SECTION[d.section]})` : "";
      const scripts = d.installScripts && d.installScripts.length > 0 ? `; install scripts: ${d.installScripts.map(printable).join(", ")}` : "";
      if (d.change === "source") return `  ~ ${printable(d.name)} ${printable(d.previous!)} -> ${printable(d.version)}${section}: now installed from another source${scripts}`;
      if (d.change === "override") {
        const was = d.previous === undefined ? "" : `${printable(d.previous)} `;
        const what = isOtherSource(d.version) ? "now installed from another source, by an override" : "overridden";
        return `  ~ ${printable(d.name)} ${was}-> ${printable(d.version)}${section}: ${what}${scripts}`;
      }
      const known = { adapter: "checked by an adapter", pure: "declared pure", detected: "detected directly", unknown: "not checked: no adapter" }[d.known];
      return `  + ${printable(d.name)} ${printable(d.version)}${section}: ${known}${scripts}`;
    });
    out.push(["New dependencies", ...rows].join("\n"));
  }
  return out.join("\n\n");
}

// --- helpers -------------------------------------------------------------------

/**
 * Settings changes (in configuration entries), and changes in the code PermLang can't check
 * (unchecked.ts), apart from changes in what code and configuration reach.
 */
function split(diff: LockDiff): { settings: FunctionChange[]; access: FunctionChange[]; unchecked: FunctionChange[] } {
  const settings: FunctionChange[] = [];
  const access: FunctionChange[] = [];
  const unchecked: FunctionChange[] = [];
  for (const f of diff.functions) {
    if (isUncheckedKey(f.key)) unchecked.push(f);
    else (isConfigKey(f.key) && [...f.added, ...f.removed].every(isSetting) ? settings : access).push(f);
  }
  return { settings, access, unchecked };
}

/** Where code PermLang can't check is first imported or called, from its entry's `via`: ", in src/app.ts:3". */
function uncheckedAt(capability: string, via: ViaPaths): string {
  const where = own(Object.entries(via).find(([key]) => isUncheckedKey(key))?.[1], capability)?.[0];
  return where === undefined ? "" : `, ${uncheckedCode(capability).kind === "import" ? "in" : "called in"} ${where}`;
}

/** Whether the code and the working tree's lock differ at all. */
function pendingChanges(notes: DiffNotes): boolean {
  const p = notes.pending;
  return p !== undefined && p.functions.length + p.unsafeAdded.length + p.unsafeRemoved.length + p.unsafeChanged.length > 0;
}

/** What the lock records but the code doesn't reach: access approved in advance. */
function lockOnly(notes: DiffNotes): FunctionChange[] {
  if (notes.lockOutdated || !notes.pending) return [];
  return notes.pending.functions
    .map((f) => ({ ...f, removed: isConfigKey(f.key) ? f.removed.filter((c) => !isSetting(c)) : f.removed }))
    .filter((f) => f.removed.length > 0);
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
    const path = own(own(via, fn.key), capability);
    if (path && (!best || path.length < best.path.length)) best = { fn, path };
  }
  return best;
}

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** At most this many characters of any one value from the code: a name, a path, a capability, a reason. */
const CELL = 500;

/** Long text from code (a reason, a call), shortened for the comment. */
function clip(text: string, max = CELL): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Items for one cell or line: at most MAX_NAMED, then how many more. */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_NAMED);
  if (items.length > MAX_NAMED) shown.push(`and ${items.length - MAX_NAMED} more`);
  return shown.join(", ");
}

/**
 * Text that comes from code (capabilities, names, paths, reasons) is escaped for
 * both HTML and markdown. A capability like fs.read(/a` | |\n<!--) must not be able
 * to end a code span, split a table cell, or open an HTML comment that hides the
 * rows after it, because reviewers approve what the comment shows. Markdown inside
 * an HTML <code> tag still renders, so this applies there too. Line breaks become
 * spaces, and other control characters and bidirectional overrides show as escapes,
 * as in the text output: `\u202e` could make the text read differently than it is.
 */
function html(value: string): string {
  return printable(value.replace(/[\r\n\u{2028}\u{2029}]+/gu, " "))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("`", "&#96;")
    .replaceAll("|", "&#124;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;")
    .replaceAll("~", "&#126;")
    .replaceAll("$", "&#36;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("\\", "&#92;");
}

/** A zero-width space: invisible, but it keeps GitHub from turning what follows into a link. */
const BREAK = "\u{200b}";

/**
 * Text from code outside code formatting. After rendering the markdown, GitHub turns some text
 * into links and notifications, where an HTML entity no longer helps: @mentions (which notify
 * people), #123 and GH-123 references, commit hashes, :emoji: codes, and URLs. A zero-width
 * space after the character that starts each one stops it, and doesn't change what's shown.
 * (Inside <code>, GitHub does none of this except linking URLs, which show as written.)
 */
function plain(value: string, max = CELL): string {
  return html(
    clip(value, max)
      .replace(/[@#:]/g, `$&${BREAK}`)
      .replace(/\b(www|gh)([.-])/gi, `$1${BREAK}$2`)
      .replace(/\b[0-9a-f]{7,}\b/gi, (hex) => hex.replace(/(.{6})(?=.)/g, `$1${BREAK}`)),
  );
}

function code(value: string): string {
  return `<code>${html(clip(value))}</code>`;
}

/** A record's own entry, never one every object has, such as `constructor`: a capability or function can be named that. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
