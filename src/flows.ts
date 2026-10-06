// Data-flow rules: where a secret or sensitive data may be sent.
//
//   "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }]
//
// A function that gets hold of the source, and can send to a host the rule doesn't list
// (itself or through what it calls, including a host that can't be determined), or can
// run a command or code that can't be verified, is a PERM009 error. A function gets hold
// of the source by reading it, or by calling something that has it and can hand it back.
// This doesn't follow the value: a key stored somewhere (a module-level constant, an
// object's field) and read by other code isn't caught.

import { Node, type Type } from "ts-morph";
import { BUILTIN_VOCABULARY, UNVERIFIABLE, covers, formatCapability, parsePermList, type Capability } from "./capability.js";
import type { Diagnostic } from "./check.js";
import { pathTo, type Edge, type Reach } from "./graph.js";
import type { Unit } from "./units.js";

export interface FlowRule {
  /** What's protected, such as env(STRIPE_KEY) or db.read(customers). */
  from: Capability;
  /** Where it may go: network hosts. */
  to: Capability[];
}

/** What a rule can protect: data a function reads. Writes and commands aren't data. */
const SOURCES = ["env", "fs.read", "db.read", "net"];

/**
 * Validates the `flows` setting from permlang.config.json.
 * @throws Error describing the first problem.
 */
export function parseFlows(raw: unknown, source: string): FlowRule[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: "flows" must be a list of { "from": ..., "to": [...] } rules.`);
  return raw.map((rule, i) => {
    const r = rule as { from?: unknown; to?: unknown };
    if (typeof rule !== "object" || rule === null || typeof r.from !== "string") throw new Error(`${source}: flows[${i}] needs a "from" capability, such as "env(STRIPE_KEY)".`);
    // A misspelled setting would otherwise be ignored, and the rule would check less than it says.
    const unknown = Object.keys(rule).find((key) => key !== "from" && key !== "to");
    if (unknown !== undefined) throw new Error(`${source}: flows[${i}] has an unknown setting "${unknown}"; a rule has only "from" and "to".`);
    if (!Array.isArray(r.to) || !r.to.every((t) => typeof t === "string")) throw new Error(`${source}: flows[${i}]: "to" must be a list of capabilities, such as ["net(api.stripe.com)"].`);
    const from = one(r.from, `flows[${i}]: invalid "from"`, source);
    if (!SOURCES.includes(from.name)) {
      throw new Error(`${source}: flows[${i}]: "from" must be data a function can read: env, fs.read, db.read, or net, with or without a scope; "${r.from}" isn't.`);
    }
    const to = (r.to as string[]).map((t) => {
      const sink = one(t, `flows[${i}]: invalid "to" entry`, source);
      if (sink.name !== "net") throw new Error(`${source}: flows[${i}]: "to" can only list network hosts, such as "net(api.stripe.com)"; "${t}" isn't one.`);
      return sink;
    });
    return { from, to };
  });
}

function one(text: string, what: string, source: string): Capability {
  const { capabilities, errors } = parsePermList(text, BUILTIN_VOCABULARY);
  if (errors.length > 0 || capabilities.length !== 1) throw new Error(`${source}: ${what} "${text}"${errors[0] ? `: ${errors[0].reason}` : ""}.`);
  return capabilities[0]!;
}

/** One error per function, rule, and place the rule doesn't allow. */
export function flowDiagnostics(units: Iterable<Unit>, edges: readonly Edge[], reach: Reach, rules: readonly FlowRule[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const rule of rules) {
    const source = formatCapability(rule.from);
    const allowed = rule.to.length > 0 ? `allows only ${rule.to.map(formatCapability).join(", ")}` : "doesn't let it go anywhere";
    for (const [unit, via] of holders(units, edges, rule)) {
      const got = via.length === 0 ? `reads ${source}` : `gets ${source} from ${via.join(" → ")}`;
      for (const [key, p] of reach.get(unit)!) {
        const anywhere = key === "exec" || key === UNVERIFIABLE;
        if (!anywhere && (p.capability.name !== "net" || covers(rule.to, p.capability))) continue;
        const site = p.edge ?? p.use;
        const path = pathTo(reach, unit, key);
        const through = path.join(" → ");
        const doing = key === "exec" ? "can run commands" : "runs code that can't be verified";
        const sink = p.capability.arg === undefined ? `${key} (a host that can't be determined)` : key;
        out.push({
          severity: "error",
          code: "PERM009",
          file: unit.file,
          line: site.line,
          column: site.column,
          function: unit.name,
          capability: key,
          call: site.call,
          path,
          message: anywhere
            ? `${unit.name} ${got} and ${doing}, through ${through}, which could send it anywhere: the flow rule for ${source} ${allowed}.`
            : `${unit.name} ${got} and can send to ${sink}, through ${through}, which the flow rule for ${source} doesn't allow.`,
          fix: anywhere
            ? `keep ${source} away from that call: no rule can allow it, since ${key === "exec" ? "a command" : "code that can't be verified"} could send it anywhere.`
            : p.capability.arg === undefined
              ? `keep ${source} away from that call, or make its host fixed so the rule can allow it.`
              : `keep ${source} away from that call, or add ${key} to the rule's "to" in permlang.config.json.`,
        });
      }
    }
  }
  return out;
}

/**
 * The units that can get hold of the rule's source, each with where it comes from (empty
 * for a direct read). A unit has it when it reads it (or something broader, such as the
 * whole environment), or when it calls a unit that has it and can hand it back.
 */
function holders(units: Iterable<Unit>, edges: readonly Edge[], rule: FlowRule): Map<Unit, string[]> {
  const has = new Map<Unit, string[]>();
  for (const unit of units) {
    if (unit.uses.some((u) => covers([rule.from], u.capability) || covers([u.capability], rule.from))) has.set(unit, []);
  }
  // Fixed point: each pass can only add units, so it ends.
  for (let changed = true; changed; ) {
    changed = false;
    for (const edge of edges) {
      const from = has.get(edge.to);
      if (from === undefined || has.has(edge.from) || !handsBack(edge.to)) continue;
      has.set(edge.from, [edge.to.name, ...from]);
      changed = true;
    }
  }
  return has;
}

/**
 * Whether what a unit has can come back to its caller: through a return value, a callback the
 * caller passed in, the object a constructor builds, or a module's exports. A function that
 * returns nothing (`void`) and takes no callback can't hand anything back, which keeps a caller
 * of `chargeCustomer(): Promise<void>` from being flagged for what it sends elsewhere.
 */
function handsBack(unit: Unit): boolean {
  const node = unit.node;
  if (Node.isSetAccessorDeclaration(node)) return false;
  const fn = Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node) ? node.getInitializer() : node;
  // A module (its exports) or a constructor (the object it builds), explicit or implicit.
  if (!fn || !(Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    return true;
  }
  if (fn.getParameters().some((p) => p.getType().getCallSignatures().length > 0 || p.getType().getUnionTypes().some((t) => t.getCallSignatures().length > 0))) return true;
  return !returnsNothing(fn.getReturnType());
}

function returnsNothing(type: Type): boolean {
  if (type.isUnion()) return type.getUnionTypes().every(returnsNothing);
  if (type.isVoid() || type.isUndefined() || type.isNull() || type.isNever()) return true;
  const awaited = type.getSymbol()?.getName() === "Promise" ? type.getTypeArguments()[0] : undefined;
  return awaited !== undefined && returnsNothing(awaited);
}
