// Compares each function's declared permissions with everything it can reach.
//
// A unit's actual permissions are its direct uses plus everything its callees
// reach, across files. Declared permissions are the unit's own @perm tags plus
// its file's @module @perm tags.

import path from "node:path";
import { Node, Project, ts } from "ts-morph";
import { AdapterError, AdapterIndex, loadAdapters } from "./adapters.js";
import { UNVERIFIABLE, covers, formatCapability } from "./capability.js";
import { detectInFile } from "./detect/index.js";
import { Hierarchy } from "./dispatch.js";
import { buildLock, lockDrift, type LockFile } from "./lock.js";
import { projectFiles } from "./project-files.js";
import { findTools, handlerReach } from "./tools.js";
import { flowDiagnostics, type FlowRule } from "./flows.js";
import { unmappedPackages, unresolvedImports, type UnmappedPackage } from "./unmapped.js";
import { unseenFrom } from "./unseen.js";
import { collectEdges, pathTo, propagate, type Edge, type Reach } from "./graph.js";
import {
  createUnit,
  declaredCapabilities,
  enclosingUnitNode,
  exportedDeclarations,
  isAnnotated,
  isInNodeModules,
  isUnitNode,
  readModuleAnnotation,
  type Unit,
  type Use,
} from "./units.js";

export type Severity = "error" | "warning";

/**
 * Spec diagnostics: SPEC001 invalid spec, SPEC002 implementation not found (or the name matches
 * more than one function), SPEC003 reaches beyond the spec, SPEC004 unused permission, SPEC005
 * the implementation reaches code PermLang can't see, so it can't be checked.
 */
export type SpecCode = "SPEC001" | "SPEC002" | "SPEC003" | "SPEC004" | "SPEC005";

export interface Diagnostic {
  severity: Severity;
  /**
   * PERM001 undeclared capability, PERM002 invalid annotation, PERM003 missing
   * annotation, PERM004 unverifiable code (eval, computed calls on sensitive objects, ...),
   * PERM005 permissions that differ from permlang.lock.json, PERM006 calls into a
   * package with no adapter (what it touches isn't checked), PERM007 an import
   * whose types can't be found (nothing called from it is checked), PERM008 a tool an AI
   * model can call reaches something dangerous, PERM009 a function gets hold of something a
   * flow rule protects and can send it somewhere the rule doesn't allow.
   */
  code: "PERM001" | "PERM002" | "PERM003" | "PERM004" | "PERM005" | "PERM006" | "PERM007" | "PERM008" | "PERM009" | SpecCode;
  file: string;
  line: number;
  column: number;
  function: string;
  /** The capability involved, formatted; for PERM002, the entry as written. */
  capability: string;
  /** The offending call as written; empty for annotation errors. */
  call: string;
  /** For capabilities reached through helpers: each unit on the way, then the call that uses it. */
  path?: string[];
  message: string;
  fix?: string;
}

export interface FunctionReport {
  file: string;
  name: string;
  line: number;
  annotated: boolean;
  declared: string[];
  actual: string[];
  /** For each actual capability: the units on the way to it, then the call that uses it. */
  via: Record<string, string[]>;
  /** For each actual capability: where in this function it's reached (a direct use, or the call leading to it). */
  sites: Record<string, { line: number; column: number }>;
  /** A configuration file (a workflow, an Action, package.json) rather than code; see project-files.ts. */
  kind?: "config";
}

/** A function whose checks are suppressed by @perm-unsafe. Always reported. */
export interface UnsafeReport {
  file: string;
  line: number;
  function: string;
  reason: string;
}

/** A function registered as a tool an AI model can call, and what it reaches. */
export interface ToolReport {
  name: string;
  /** The package it's registered with. */
  framework: string;
  file: string;
  line: number;
  /** The unit that registers it. */
  function: string;
  reaches: string[];
}

export interface Report {
  files: number;
  functions: FunctionReport[];
  diagnostics: Diagnostic[];
  unsafe: UnsafeReport[];
  /** Packages called with no adapter, most calls first. PermLang trusts them (D1). */
  unmapped: UnmappedPackage[];
  /** Imported modules whose types can't be found, so nothing called from them is checked. */
  unresolved: string[];
  /** Every function analyzed, including those that reach nothing (which `functions` leaves out). */
  units: {
    file: string;
    name: string;
    line: number;
    /** The name with what it's declared in: `Reports.build` for a function in `namespace Reports`. */
    qualified: string;
    /**
     * Why some of what it runs can't be seen: imports whose types can't be found, names with no
     * declaration. Worked out on demand (it needs TypeScript's full diagnostics), for `permlang spec`.
     */
    unseen: () => string[];
  }[];
  /** Functions registered as tools an AI model can call. */
  tools: ToolReport[];
}

/**
 * How strictly annotations are enforced (design doc §7). An out-of-date lock
 * file fails at every level: it is the review gate, not an annotation rule. So do
 * flow rules, and "error" policies for unmapped packages and AI tools: they are
 * asked for explicitly in the configuration.
 *   sketch       permissions are inferred and reported; annotation rules don't fail
 *   development  exported functions and entry points must declare what they reach (default)
 *   production   every function must be covered by function- or module-level @perm
 */
export type Strictness = "sketch" | "development" | "production";

export const STRICTNESS_LEVELS: readonly Strictness[] = ["sketch", "development", "production"];

/** The rules about @perm annotations, which sketch reports as warnings. */
const ANNOTATION_RULES: ReadonlySet<Diagnostic["code"]> = new Set(["PERM001", "PERM002", "PERM003", "PERM004"]);

export interface CheckOptions {
  /** Team adapter manifests, loaded before (and taking precedence over) the built-in ones. */
  adapters?: readonly string[];
  strictness?: Strictness;
  /** The committed lock file to compare against; keys are relative to its directory. */
  lock?: { file: string; contents: LockFile };
  /** How to report calls into packages with no adapter: warn (default), error, or trust (report only). */
  unmapped?: UnmappedPolicy;
  /** How to report AI tools that reach something dangerous: warn (default), error, or trust (report only). */
  tools?: UnmappedPolicy;
  /** Where protected data may go: `{ from: env(STRIPE_KEY), to: [net(api.stripe.com)] }`. See flows.ts. */
  flows?: readonly FlowRule[];
  /**
   * The repository root whose configuration is also recorded: its GitHub workflows and
   * Actions, and package.json scripts (see project-files.ts). The CLI passes the lock's folder.
   */
  projectRoot?: string;
}

export type UnmappedPolicy = "warn" | "error" | "trust";

export const UNMAPPED_POLICIES: readonly UnmappedPolicy[] = ["warn", "error", "trust"];

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  allowJs: false,
  noEmit: true,
  skipLibCheck: true,
};

// These read source files through ts-morph too. ts-morph has no adapter, so that
// read isn't detected (design doc decision D1); fs.read covers it anyway.

/** @perm fs.read */
export function checkFiles(files: readonly string[], options: CheckOptions = {}): Report {
  const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
  project.addSourceFilesAtPaths([...files]);
  return checkProject(project, options);
}

/** @perm fs.read */
export function checkTsConfig(tsConfigFilePath: string, options: CheckOptions = {}): Report {
  return checkProject(new Project({ tsConfigFilePath }), options);
}

/**
 * @throws AdapterError when an adapter manifest is invalid.
 * @perm fs.read
 */
export function checkProject(project: Project, options: CheckOptions = {}): Report {
  const loaded = loadAdapters(options.adapters ?? []);
  if (loaded.errors.length > 0) throw new AdapterError(loaded.errors);
  const adapters = new AdapterIndex(loaded.adapters);
  const strictness = options.strictness ?? "development";

  const sourceFiles = project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && !isInNodeModules(sf));
  const units = new Map<Node, Unit>();
  const diagnostics: Diagnostic[] = [];

  // 1. Every unit in every file, with its annotations and direct uses.
  for (const sourceFile of sourceFiles) {
    const module = readModuleAnnotation(sourceFile, adapters.vocabulary);
    const exports = exportedDeclarations(sourceFile);
    const add = (node: Node) => units.set(node, createUnit(node, module, exports, adapters.vocabulary));

    add(sourceFile);
    sourceFile.forEachDescendant((node) => {
      if (isUnitNode(node)) add(node);
    });
    for (const e of module?.errors ?? []) diagnostics.push(annotationError(sourceFile.getFilePath(), "<module>", e));

    for (const { node, uses } of detectInFile(sourceFile, adapters)) {
      const unit = units.get(enclosingUnitNode(node))!;
      const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
      for (const u of uses) unit.uses.push({ ...u, line, column });
    }
  }

  // 2. Edges between units, then what each unit can reach.
  const context = { unitOf: (node: Node) => units.get(node), hierarchy: new Hierarchy(sourceFiles), adapters };
  const edges = sourceFiles.flatMap((sf) => collectEdges(sf, context));
  const reach = propagate(units.values(), edges);
  const edgesFrom = groupBy(edges, (e) => e.from);

  // 3. Compare declared with actual.
  const functions: FunctionReport[] = [];
  for (const unit of units.values()) {
    const reached = reach.get(unit)!;
    if (!isAnnotated(unit) && reached.size === 0) continue;
    functions.push(summarize(unit, reach));
    diagnostics.push(...diagnose(unit, edgesFrom.get(unit) ?? [], reach, strictness));
  }

  // Configuration files are recorded like functions: what they grant, at the line that grants it.
  if (options.projectRoot) functions.push(...projectFiles(options.projectRoot));

  const unsafe = [...units.values()].flatMap((u) =>
    u.own?.unsafe ? [{ file: u.file, line: u.own.unsafe.line, function: u.name, reason: u.own.unsafe.reason }] : [],
  );
  unsafe.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Packages with no adapter: listed always; a diagnostic unless trusted.
  const unmappedUses = unmappedPackages(sourceFiles, adapters);
  const policy = options.unmapped ?? "warn";
  if (policy !== "trust") {
    for (const u of unmappedUses) {
      const unit = units.get(enclosingUnitNode(u.node))!;
      diagnostics.push({
        severity: policy === "error" ? "error" : "warning",
        code: "PERM006",
        file: u.file,
        line: u.line,
        column: u.node.getSourceFile().getLineAndColumnAtPos(u.node.getStart()).column,
        function: unit.name,
        capability: u.package,
        call: "",
        message: `${unit.name} calls into ${u.package} (${u.calls} call${u.calls === 1 ? "" : "s"} in ${u.files} file${u.files === 1 ? "" : "s"}), which has no adapter, so what it touches isn't checked.`,
        fix: `add an adapter manifest for ${u.package}, or declare it pure with "default": [] (see docs/reference.md).`,
      });
    }
  }
  const unmapped = unmappedUses.map(({ package: pkg, calls, file, line }) => ({ package: pkg, calls, file, line }));

  // Imports with no types: nothing called from them resolves, so the same policy applies.
  const unresolved = unresolvedImports(sourceFiles);
  if (policy !== "trust") {
    for (const u of unresolved) {
      diagnostics.push({
        severity: policy === "error" ? "error" : "warning",
        code: "PERM007",
        file: u.file,
        line: u.line,
        column: 1,
        function: "<module>",
        capability: u.specifier,
        call: "",
        message: `imports ${u.specifier}, whose types can't be found, so nothing called from it is checked.`,
        fix: /^node:|^(fs|child_process|http|https|net|path|os|crypto)$/.test(u.specifier)
          ? "install @types/node."
          : `install its types (the package itself, or @types/${u.specifier.replace(/^@/, "").replace("/", "__")}).`,
      });
    }
  }

  // Tools an AI model can call: listed always; a diagnostic when they reach something dangerous.
  const tools: ToolReport[] = [];
  const toolPolicy = options.tools ?? "warn";
  const registered = new Set<Node>();
  for (const sourceFile of sourceFiles) {
    for (const t of findTools(sourceFile)) {
      // A `tools` object shared by several calls is registered once.
      if (registered.has(t.site)) continue;
      registered.add(t.site);
      const registrar = units.get(enclosingUnitNode(t.site))!;
      const reaches = [...handlerReach(t, { units, reach, edgesFrom })].sort();
      const file = t.site.getSourceFile();
      const { line, column } = file.getLineAndColumnAtPos(t.site.getStart());
      tools.push({ name: t.name, framework: t.framework, file: file.getFilePath(), line, function: registrar.name, reaches });
      const risky = reaches.filter(isRiskyForTools);
      if (toolPolicy === "trust" || risky.length === 0) continue;
      diagnostics.push({
        severity: toolPolicy === "error" ? "error" : "warning",
        code: "PERM008",
        file: file.getFilePath(),
        line,
        column,
        function: registrar.name,
        capability: t.name,
        call: "",
        message: `tool ${t.name} (${t.framework}) can be called by an AI model, and reaches ${risky.join(", ")}.`,
        fix: "anyone who controls the model's input can trigger it: limit what the tool can do, validate its arguments, or have a person confirm before it runs.",
      });
    }
  }

  // Data-flow rules: a function that reads protected data and can send it elsewhere.
  if (options.flows && options.flows.length > 0) diagnostics.push(...flowDiagnostics(units.values(), edges, reach, options.flows));

  // Sketch relaxes the annotation rules only. What the configuration asks for explicitly (flow
  // rules, and "error" for unmapped packages or AI tools) fails at every level.
  const checked = strictness === "sketch" ? diagnostics.map((d) => (ANNOTATION_RULES.has(d.code) ? { ...d, severity: "warning" as const } : d)) : diagnostics;
  const report: Report = {
    files: sourceFiles.length,
    functions,
    diagnostics: checked,
    unsafe,
    unmapped,
    unresolved: unresolved.map((u) => u.specifier).sort(),
    units: [...units.values()].map((u) => ({
      file: u.file,
      name: u.name,
      line: u.line,
      qualified: qualifiedName(u, units),
      unseen: () => unseenFrom(u, edgesFrom, (node) => units.get(node)),
    })),
    tools,
  };
  if (options.lock) {
    const root = path.dirname(options.lock.file);
    report.diagnostics.push(...lockDrift(options.lock.contents, buildLock(report, root), report, options.lock.file));
  }
  report.diagnostics = dedupe(report.diagnostics);
  return report;
}

// --- tools -------------------------------------------------------------------

/**
 * What a model shouldn't be able to trigger unchecked: running code or commands, writing
 * files or data, sending to a host that isn't fixed, reading a file, table, or variable that
 * isn't fixed, and actions adapters define (`payments.refund`, `email.send`). Reading from a
 * known host, file, table, or variable is what tools are for.
 */
export function isRiskyForTools(capability: string): boolean {
  // Without a scope, the model can choose: where data goes (`net`), or which file, table, or
  // secret it reads back (`fs.read`, `db.read`, `env`, which is also the whole environment).
  if (["net", "fs.read", "db.read", "env"].includes(capability)) return true;
  // Everything else is risky except reads: exec, writes, unverifiable code, and app-level actions.
  return !["net", "fs.read", "db.read", "env"].includes(capability.split("(")[0]!);
}

/** A unit's name with the namespaces and functions it's declared in, outermost first: `Reports.build`. */
function qualifiedName(unit: Unit, units: ReadonlyMap<Node, Unit>): string {
  const outer: string[] = [];
  for (const a of unit.node.getAncestors()) {
    // A method's name already has its class.
    if (Node.isClassDeclaration(a) || Node.isClassExpression(a)) continue;
    if (Node.isModuleDeclaration(a) && !Node.isStringLiteral(a.getNameNode())) outer.unshift(a.getName());
    else if (!Node.isSourceFile(a) && units.has(a)) outer.unshift(units.get(a)!.name);
  }
  return [...outer, unit.name].join(".");
}

// --- diagnostics -------------------------------------------------------------

function summarize(unit: Unit, reach: Reach): FunctionReport {
  const via = Object.fromEntries([...reach.get(unit)!.keys()].map((key) => [key, pathTo(reach, unit, key)]));
  return {
    file: unit.file,
    name: unit.name,
    line: unit.line,
    annotated: isAnnotated(unit),
    declared: [...new Set(declaredCapabilities(unit).map(formatCapability))],
    actual: [...reach.get(unit)!.keys()],
    via,
    sites: Object.fromEntries([...reach.get(unit)!].map(([key, p]) => {
      const site = p.edge ?? p.use;
      return [key, { line: site.line, column: site.column }];
    })),
  };
}

function diagnose(unit: Unit, edges: readonly Edge[], reach: Reach, strictness: Strictness): Diagnostic[] {
  const out: Diagnostic[] = (unit.own?.errors ?? []).map((e) => annotationError(unit.file, unit.name, e));

  if (!isAnnotated(unit)) {
    // development: exported functions and top-level code must declare; production: everything.
    if (unit.exported || strictness === "production") out.push(...missingAnnotation(unit, reach));
    return out;
  }
  // @perm-unsafe suppresses this unit's own checks. Its callers still see what it reaches.
  if (unit.own?.unsafe) return out;

  const declared = declaredCapabilities(unit);
  for (const use of unit.uses) {
    if (covers(declared, use.capability)) continue;
    out.push(violation(unit, use, use.verb, formatCapability(use.capability), [], use.capability.dynamic === true));
  }
  for (const edge of edges) {
    if (edge.to === unit) continue; // recursion into itself adds nothing new
    for (const [key, p] of reach.get(edge.to)!) {
      if (covers(declared, p.capability)) continue;
      if (key === UNVERIFIABLE && edge.to.own?.unsafe) continue; // vouched for by @perm-unsafe
      const path = [edge.to.name, ...pathTo(reach, edge.to, key)];
      out.push(violation(unit, edge, "calls", key, path, p.capability.dynamic === true));
    }
  }
  return out;
}

/** What a capability's argument names, for "its ___ can't be determined statically". */
function scopeWord(capability: string): string {
  if (capability === "net") return "host";
  if (capability.startsWith("fs.")) return "path";
  if (capability.startsWith("db.")) return "table";
  if (capability === "env") return "variable name";
  return "argument";
}

function violation(
  unit: Unit,
  site: Use | Edge,
  verb: string,
  capability: string,
  path: string[],
  dynamic: boolean,
): Diagnostic {
  const via = path.length > 0 ? `, reaching ${path.join(" → ")}` : "";
  if (capability === UNVERIFIABLE) return unverifiable(unit, site, verb, path, "error");
  const reason = dynamic
    ? `its ${scopeWord(capability)} can't be determined statically, so it needs ${capability}`
    : `its declared permissions do not include ${capability}`;
  return {
    severity: "error",
    code: "PERM001",
    file: unit.file,
    line: site.line,
    column: site.column,
    function: unit.name,
    capability,
    call: site.call,
    ...(path.length > 0 ? { path } : {}),
    message: `${unit.name} ${verb} ${site.call}${via}\n  but ${reason}.`,
    fix: `add ${capability} to @perm, or remove the call.`,
  };
}

/** Code whose effects can't be known. Only @perm-unsafe accepts it. */
function unverifiable(unit: Unit, site: Use | Edge, verb: string, path: string[], severity: Severity): Diagnostic {
  const via = path.length > 0 ? `, reaching ${path.join(" → ")}` : "";
  return {
    severity,
    code: "PERM004",
    file: unit.file,
    line: site.line,
    column: site.column,
    function: unit.name,
    capability: UNVERIFIABLE,
    call: site.call,
    ...(path.length > 0 ? { path } : {}),
    message: `${unit.name} ${verb} ${site.call}${via}
  which can't be verified statically.`,
    fix: `rewrite it so what it calls is known statically, or mark ${path.length > 0 ? "the function that does it" : unit.name} @perm-unsafe with a reason.`,
  };
}

/** One error per capability an unannotated unit reaches, at the first place it does. */
function missingAnnotation(unit: Unit, reach: Reach): Diagnostic[] {
  return [...reach.get(unit)!].map(([key, p]) => {
    const site = p.edge ?? p.use;
    const path = p.edge ? [p.edge.to.name, ...pathTo(reach, p.edge.to, key)] : [];
    if (key === UNVERIFIABLE) return unverifiable(unit, site, p.edge ? "calls" : p.use.verb, path, "error");
    const via = path.length > 0 ? `, reaching ${path.join(" → ")},` : "";
    return {
      severity: "error",
      code: "PERM003",
      file: unit.file,
      line: site.line,
      column: site.column,
      function: unit.name,
      capability: key,
      call: site.call,
      ...(path.length > 0 ? { path } : {}),
      message: `${unit.name} ${p.edge ? "calls" : p.use.verb} ${site.call}${via} but has no @perm annotation.`,
      fix: `add /** @perm ${key} */ to ${unit.name}.`,
    } satisfies Diagnostic;
  });
}

function annotationError(file: string, name: string, e: { text: string; reason: string; line: number; column: number }): Diagnostic {
  return {
    severity: "error",
    code: "PERM002",
    file,
    line: e.line,
    column: e.column,
    function: name,
    capability: e.text,
    call: "",
    message: `invalid @perm entry "${e.text}" on ${name}: ${e.reason}.`,
  };
}

/** One diagnostic per function, line, and capability; sorted by location. */
function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
    .filter((d) => {
      const key = [d.file, d.line, d.code, d.function, d.capability].join("\0");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}
