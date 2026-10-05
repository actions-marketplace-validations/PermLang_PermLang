// Data-flow rules: where a secret or sensitive data may be sent.
//
//   "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }]
//
// A function that reads the source directly, and can send to a host the rule doesn't
// list (itself or through what it calls, including a host that can't be determined),
// is a PERM009 error. This first version works per function: it doesn't follow the
// value, so a key read into a module-level constant and used in another function isn't
// caught. The rule's sinks are network hosts.

import { BUILTIN_VOCABULARY, covers, formatCapability, parsePermList, type Capability } from "./capability.js";
import type { Diagnostic } from "./check.js";
import { pathTo, type Reach } from "./graph.js";
import type { Unit } from "./units.js";

export interface FlowRule {
  /** What's protected, such as env(STRIPE_KEY) or db.read(users). */
  from: Capability;
  /** Where it may go: network hosts. */
  to: Capability[];
}

/**
 * Validates the `flows` setting from permlang.config.json.
 * @throws Error describing the first problem.
 */
export function parseFlows(raw: unknown, source: string): FlowRule[] {
  if (!Array.isArray(raw)) throw new Error(`${source}: "flows" must be a list of { "from": ..., "to": [...] } rules.`);
  return raw.map((rule, i) => {
    const r = rule as { from?: unknown; to?: unknown };
    if (typeof rule !== "object" || rule === null || typeof r.from !== "string") throw new Error(`${source}: flows[${i}] needs a "from" capability, such as "env(STRIPE_KEY)".`);
    if (!Array.isArray(r.to) || !r.to.every((t) => typeof t === "string")) throw new Error(`${source}: flows[${i}]: "to" must be a list of capabilities, such as ["net(api.stripe.com)"].`);
    const from = one(r.from, `flows[${i}]: invalid "from"`, source);
    return { from, to: (r.to as string[]).map((t) => one(t, `flows[${i}]: invalid "to" entry`, source)) };
  });
}

function one(text: string, what: string, source: string): Capability {
  const { capabilities, errors } = parsePermList(text, BUILTIN_VOCABULARY);
  if (errors.length > 0 || capabilities.length !== 1) throw new Error(`${source}: ${what} "${text}"${errors[0] ? `: ${errors[0].reason}` : ""}.`);
  return capabilities[0]!;
}

/** One error per function, rule, and host the rule doesn't allow. */
export function flowDiagnostics(units: Iterable<Unit>, reach: Reach, rules: readonly FlowRule[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const unit of units) {
    for (const rule of rules) {
      // A direct read of the source, or of something broader (the whole environment).
      if (!unit.uses.some((u) => covers([rule.from], u.capability) || covers([u.capability], rule.from))) continue;
      const source = formatCapability(rule.from);
      for (const [key, p] of reach.get(unit)!) {
        if (p.capability.name !== "net" || covers(rule.to, p.capability)) continue;
        const site = p.edge ?? p.use;
        const path = pathTo(reach, unit, key);
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
          message: `${unit.name} reads ${source} and can send to ${sink}, through ${path.join(" → ")}, which the flow rule for ${source} doesn't allow.`,
          fix:
            p.capability.arg === undefined
              ? `keep ${source} away from that call, or make its host fixed so the rule can allow it.`
              : `keep ${source} away from that call, or add ${key} to the rule's "to" in permlang.config.json.`,
        });
      }
    }
  }
  return out;
}
