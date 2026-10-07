// Human-readable, JSON, GitHub annotation, and SARIF output for a check report.

import path from "node:path";
import type { Diagnostic, Report } from "./check.js";

/** What each diagnostic code means, for SARIF rules (and the reference's list of codes). */
const RULES: Record<Diagnostic["code"], string> = {
  PERM001: "A function reaches a capability its @perm doesn't declare.",
  PERM002: "An @perm annotation is invalid.",
  PERM003: "A function that must declare its permissions has no @perm.",
  PERM004: "Code whose effects can't be determined statically.",
  PERM005: "The code and permlang.lock.json differ (new access, or access the code no longer has), or the lock file is missing, or isn't the one the base commit checks with.",
  PERM006: "A call into a package with no adapter: what it touches isn't checked.",
  PERM007: "An import whose types can't be found: nothing called from it is checked.",
  PERM008: "A tool an AI model can call reaches something dangerous, such as running commands or writing data.",
  PERM009: "A function reads data a flow rule protects and can send it somewhere the rule doesn't allow.",
  SPEC001: "A .perm spec file is invalid.",
  SPEC002: "A .perm spec's implementation can't be found, or its name matches more than one function.",
  SPEC003: "A spec's implementation reaches something its perms don't allow.",
  SPEC004: "A spec allows a permission its implementation never uses.",
  SPEC005: "A spec's implementation reaches code PermLang can't see, such as an import whose types can't be found, so it can't be checked.",
};
const HELP = "https://github.com/PermLang/PermLang/blob/main/docs/reference.md#diagnostic-codes";

/**
 * SARIF 2.1.0, the format GitHub code scanning reads: findings then show in the repository's
 * Security tab. Paths are relative to `root`, the repository root. An empty report is an empty
 * run, so alerts for fixed problems close.
 */
export function toSarif(report: Report, root: string, version: string): string {
  const codes = [...new Set(report.diagnostics.map((d) => d.code))].sort();
  const results = report.diagnostics.map((d) => ({
    ruleId: d.code,
    ruleIndex: codes.indexOf(d.code),
    level: d.severity === "error" ? "error" : "warning",
    message: { text: d.message.split("\n").map((l) => l.trim()).join(" ") + (d.fix ? ` Fix: ${d.fix}` : "") },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: uri(relative(d.file, root)), uriBaseId: "%SRCROOT%" },
          region: { startLine: d.line, startColumn: d.column },
        },
      },
    ],
    properties: { capability: d.capability, function: d.function },
  }));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "PermLang",
            version,
            informationUri: "https://github.com/PermLang/PermLang",
            rules: codes.map((id) => ({ id, shortDescription: { text: RULES[id] }, helpUri: HELP })),
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/**
 * The human-readable report. Every value in it that comes from the analyzed code or a file
 * (names, paths, capabilities, reasons) goes through printable(), so none can start a line
 * of its own.
 */
export function formatText(report: Report, cwd = process.cwd()): string {
  const lines = report.diagnostics.map((d) => formatDiagnostic(d, cwd));
  const errors = report.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = report.diagnostics.length - errors;
  const files = plural(report.files, "file");

  if (report.unresolved.length > 0) {
    lines.push(`${plural(report.unresolved.length, "import")} with no types, unchecked: ${report.unresolved.map(printable).join(", ")}.`);
  }
  if (report.unmapped.length > 0) {
    const shown = report.unmapped.slice(0, 10).map((u) => `${printable(u.package)} (${u.calls})`).join(", ");
    const more = report.unmapped.length > 10 ? `, and ${report.unmapped.length - 10} more (see --json)` : "";
    lines.push(`${plural(report.unmapped.length, "package")} with no adapter, trusted (calls): ${shown}${more}.`);
  }
  if (report.tools.length > 0) {
    const entries = report.tools.map((t) => {
      const reaches = t.reaches.length > 0 ? t.reaches.map(printable).join(", ") : "nothing tracked";
      return `  ${printable(relative(t.file, cwd))}:${t.line} ${printable(t.name)} (${printable(t.framework)}): ${reaches}`;
    });
    lines.push([`${plural(report.tools.length, "tool")} an AI model can call:`, ...entries].join("\n"));
  }
  if (report.unsafe.length > 0) {
    const entries = report.unsafe.map((u) => `  ${printable(relative(u.file, cwd))}:${u.line} ${printable(u.function)}: ${printable(u.reason)}`);
    lines.push([`${plural(report.unsafe.length, "@perm-unsafe override")} (checks suppressed):`, ...entries].join("\n"));
  }
  if (report.diagnostics.length === 0) {
    lines.push(`No permission violations in ${files}.`);
  } else {
    lines.push(`${plural(errors, "error")}, ${plural(warnings, "warning")} in ${files}.`);
  }
  return lines.join("\n\n");
}

/**
 * PermLang's own messages break at most once, before the reason ("but ...", "which ...").
 * Any other line break in a message comes from a value in the code, and is escaped with it.
 * Only spaces and tabs follow the break: `\s*` would match line breaks too, and scan a message
 * full of them (text from the code) in quadratic time.
 */
const OWN_BREAK = /\n[ \t]*(?=but |which )/;

function formatDiagnostic(d: Diagnostic, cwd: string): string {
  const location = `${relative(d.file, cwd)}:${d.line}:${d.column}`;
  const [first, reason] = messageLines(d);
  const out = [`${printable(location)} ${d.severity} ${d.code}: ${first}`];
  if (reason !== undefined) out.push(`  ${reason}`);
  if (d.fix) out.push(`  -> ${printable(d.fix)}`);
  return out.join("\n");
}

/** A diagnostic's message as at most two printable lines: split at PermLang's own break, if it has one. */
function messageLines(d: Diagnostic): [string, string?] {
  const own = OWN_BREAK.exec(d.message);
  if (!own) return [printable(d.message)];
  return [printable(d.message.slice(0, own.index)), printable(d.message.slice(own.index + own[0].length))];
}

/**
 * Text from analyzed code or files, made safe to print on one line: line breaks, control
 * characters (terminal escape sequences included), Unicode line separators, and bidirectional
 * overrides become visible escapes such as `\n` and `\u001b`. Otherwise a string in the code
 * could print a line of its own, which GitHub Actions obeys when it starts with `::` (a
 * workflow command that can hide annotations or add fake ones), or drive the terminal.
 */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, (c) => SHORT_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const UNPRINTABLE = /[\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
const SHORT_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

export function toJson(report: Report, cwd = process.cwd()): string {
  return JSON.stringify(
    {
      version: 1,
      files: report.files,
      functions: report.functions.map((f) => ({ ...f, file: relative(f.file, cwd) })),
      diagnostics: report.diagnostics.map((d) => ({ ...d, file: relative(d.file, cwd) })),
      unsafe: report.unsafe.map((u) => ({ ...u, file: relative(u.file, cwd) })),
      unmapped: report.unmapped.map((u) => ({ ...u, file: relative(u.file, cwd) })),
      unresolved: report.unresolved,
      tools: report.tools.map((t) => ({ ...t, file: relative(t.file, cwd) })),
    },
    null,
    2,
  );
}

/**
 * GitHub Actions workflow commands, one per diagnostic, so each shows on its line in a pull
 * request. `root` is the repository root (GITHUB_WORKSPACE), which annotation paths are relative to.
 * Errors come first: GitHub shows only the first few annotations of each kind per step. Text
 * from the code is printable(), as in the text report: an escape sequence or a bidirectional
 * override would otherwise reach the log and the annotation as it is.
 */
export function formatAnnotations(report: Report, root: string): string {
  const ordered = [...report.diagnostics].sort((a, b) => Number(a.severity !== "error") - Number(b.severity !== "error"));
  return ordered
    .map((d) => {
      const message = messageLines(d).join("\n") + (d.fix ? `\n-> ${printable(d.fix)}` : "");
      const title = `PermLang ${d.code}${d.capability ? `: ${printable(d.capability)}` : ""}`;
      const properties = [`file=${property(printable(relative(d.file, root)))}`, `line=${d.line}`, `col=${d.column}`, `title=${property(title)}`];
      return `::${d.severity === "error" ? "error" : "warning"} ${properties.join(",")}::${data(message)}`;
    })
    .join("\n");
}

// GitHub's escaping for workflow commands: the message can't contain a raw newline, which would
// let code text start a command of its own; properties also can't contain `:` or `,`.
function data(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function property(text: string): string {
  return data(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function relative(file: string, cwd: string): string {
  return path.relative(cwd, file).replaceAll("\\", "/");
}

/** A relative path as a URI reference, each segment percent-encoded: `my lib/a#b.ts` → `my%20lib/a%23b.ts`. */
function uri(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
