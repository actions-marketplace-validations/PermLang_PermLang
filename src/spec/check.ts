// Checks specs against the code that implements them. Phase 2 groundwork:
//   - perms:    verified. The implementation's actual reach must stay within them
//               (SPEC003), and unused permissions are reported (SPEC004). An
//               implementation that reaches code PermLang can't see, such as an import
//               whose types are missing, can't be verified (SPEC005).
//   - must:     parsed and counted, not verified yet.
//   - examples: parsed and counted, not run yet.
// Nothing reports rules, examples, or permissions as passing until they are really checked.

import path from "node:path";
import { covers, formatCapability, type Capability } from "../capability.js";
import type { Diagnostic, FunctionReport, Report } from "../check.js";
import type { Spec } from "./parse.js";

export interface SpecResult {
  spec: Spec;
  implementation?: FunctionReport | { file: string; name: string; actual: string[]; via: Record<string, string[]> };
  status: "perms ok" | "perms exceeded" | "unchecked" | "not found" | "ambiguous";
  /** Every spec diagnostic says how to fix it. */
  diagnostics: (Diagnostic & { fix: string })[];
  must: { count: number; verified: false };
  examples: { count: number; run: false };
}

type ReportedUnit = Report["units"][number];

export function checkSpecs(specs: readonly Spec[], report: Report): SpecResult[] {
  return specs.map((spec) => {
    const base = { spec, must: { count: spec.must.length, verified: false as const }, examples: { count: spec.examples.length, run: false as const } };
    const at = (line: number) => ({ file: spec.file, line, column: 1, function: spec.name, call: "" });

    if (!spec.implements) {
      return { ...base, status: "not found" as const, diagnostics: [{ ...at(spec.line), severity: "error" as const, code: "SPEC002" as const, capability: "", message: `perm ${spec.name} has no implements: line, so it can't be checked.`, fix: "add implements: path/to/file.ts#functionName." }] };
    }
    const written = `${spec.implements.file}#${spec.implements.symbol}`;
    const target = normalize(path.resolve(path.dirname(spec.file), spec.implements.file));
    const matches = report.units.filter((u) => normalize(u.file) === target && (u.name === spec.implements!.symbol || u.qualified === spec.implements!.symbol));
    if (matches.length === 0) {
      return { ...base, status: "not found" as const, diagnostics: [{ ...at(spec.implements.line), severity: "error" as const, code: "SPEC002" as const, capability: written, message: `perm ${spec.name}: ${written} wasn't found among the checked files.`, fix: "check the path and function name, and that the file is part of the checked sources." }] };
    }
    // Checking only one of several same-named functions would pass a spec the others break.
    const names = [...new Set(matches.map((u) => u.qualified))];
    if (names.length > 1) {
      const listed = matches.map((u) => `${u.qualified} (line ${u.line})`).join(", ");
      return {
        ...base,
        status: "ambiguous" as const,
        diagnostics: [{
          ...at(spec.implements.line),
          severity: "error" as const,
          code: "SPEC002" as const,
          capability: written,
          message: `perm ${spec.name}: ${written} matches ${matches.length} functions: ${listed}, so it's not clear which one implements the spec.`,
          fix: `write the qualified name, such as implements: ${spec.implements.file}#${names[0]}.`,
        }],
      };
    }
    // One name, possibly a getter and a setter of the same property: they're checked together.
    const implementation = combined(matches, report);
    const unseen = [...new Set(matches.flatMap((u) => u.unseen()))].sort();

    const actual = implementation.actual.map(parseCapability);
    const diagnostics: SpecResult["diagnostics"] = [];
    for (const [i, capability] of actual.entries()) {
      if (covers(spec.perms, capability)) continue;
      const key = implementation.actual[i]!;
      const via = implementation.via[key];
      diagnostics.push({
        ...at(spec.implements.line),
        severity: "error",
        code: "SPEC003",
        capability: key,
        message: `${implementation.name} reaches ${key}${via ? `, via ${via.join(" → ")}` : ""}, which perm ${spec.name} doesn't allow.`,
        fix: `add ${key} to the spec's perms:, or remove the access.`,
      });
    }
    if (unseen.length > 0) {
      diagnostics.push({
        ...at(spec.implements.line),
        severity: "error",
        code: "SPEC005",
        capability: written,
        message: `perm ${spec.name}: ${implementation.name} reaches code PermLang can't see, so its permissions can't be checked: ${unseen.join("; ")}.`,
        fix: "install the missing types (@types/node for Node's modules and globals, such as process), then run it again.",
      });
    }
    // A permission that looks unused may be used by the code that can't be seen.
    for (const permission of unseen.length > 0 ? [] : spec.perms) {
      if (actual.some((a) => covers([permission], a))) continue;
      diagnostics.push({
        ...at(spec.line),
        severity: "warning",
        code: "SPEC004",
        capability: formatCapability(permission),
        message: `perm ${spec.name} allows ${formatCapability(permission)}, but ${implementation.name} never uses it.`,
        fix: "remove it from perms: to keep the spec's permissions minimal.",
      });
    }
    const exceeded = diagnostics.some((d) => d.code === "SPEC003");
    const status = exceeded ? ("perms exceeded" as const) : unseen.length > 0 ? ("unchecked" as const) : ("perms ok" as const);
    return { ...base, implementation, status, diagnostics };
  });
}

/** What the matched functions reach, together. A function that reaches nothing isn't in report.functions. */
function combined(matches: readonly ReportedUnit[], report: Report): NonNullable<SpecResult["implementation"]> {
  const reports = matches.map(
    (u) => report.functions.find((f) => f.file === u.file && f.name === u.name && f.line === u.line) ?? { file: u.file, name: u.name, actual: [] as string[], via: {} as Record<string, string[]> },
  );
  if (reports.length === 1) return reports[0]!;
  return {
    file: reports[0]!.file,
    name: reports[0]!.name,
    actual: [...new Set(reports.flatMap((r) => r.actual))],
    via: Object.assign({}, ...reports.map((r) => r.via)) as Record<string, string[]>,
  };
}

/** "net(api.stripe.com)" → { name: "net", arg: "api.stripe.com" }; a bare name has no arg. */
function parseCapability(text: string): Capability {
  const m = /^([^()]+)(?:\((.*)\))?$/.exec(text);
  return m && m[2] !== undefined ? { name: m[1]!, arg: m[2] } : { name: text };
}

// Windows and macOS file systems ignore case by default; Linux's don't, where
// src/Refunds.ts and src/refunds.ts are different files.
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function normalize(file: string): string {
  const resolved = path.resolve(file).replaceAll("\\", "/");
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

/** The report text for `permlang spec`, in the shape of the concept overview's example. */
export function formatSpecResults(results: readonly SpecResult[], cwd = process.cwd()): string {
  const blocks = results.map((r) => {
    const impl = r.spec.implements ? `${r.spec.implements.file}#${r.spec.implements.symbol}` : "(no implements:)";
    const lines = [
      `perm ${r.spec.name}  ${impl}`,
      `  perms     ${permsLine(r)}`,
      `  must      ${r.must.count} rule${r.must.count === 1 ? "" : "s"}, not verified yet (phase 2)`,
      `  examples  ${r.examples.count} example${r.examples.count === 1 ? "" : "s"}, not run yet (phase 2)`,
    ];
    for (const d of r.diagnostics) {
      lines.push(`  ${path.relative(cwd, d.file).replaceAll("\\", "/")}:${d.line} ${d.severity} ${d.code}: ${d.message}`);
      lines.push(`    -> ${d.fix}`);
    }
    return lines.join("\n");
  });
  const failed = results.filter((r) => r.status !== "perms ok").length;
  blocks.push(results.length === 0 ? "No .perm specs found." : `${results.length} spec${results.length === 1 ? "" : "s"}, ${failed} failing.`);
  return blocks.join("\n\n");
}

function permsLine(r: SpecResult): string {
  if (r.status === "not found") return "implementation not found";
  if (r.status === "ambiguous") return "implementation is ambiguous: write its qualified name";
  if (r.status === "perms exceeded") return `FAIL: reaches ${r.diagnostics.filter((d) => d.code === "SPEC003").map((d) => d.capability).join(", ")}`;
  if (r.status === "unchecked") return "unchecked: reaches code whose types can't be found";
  return "no access beyond the declared scope";
}
