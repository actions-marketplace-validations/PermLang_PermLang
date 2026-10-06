// The call graph between units, and propagation of capabilities along it.
//
// An edge is anything that can make one unit's code run another's:
//   - a reference, not only a call: passing `helper` to `map` or `setTimeout`
//     lets it run (references in type positions, imports, and exports don't count);
//   - the declaration a call resolves to, which covers `super()`, literal
//     computed keys (`api["ping"]()`), and calls through const aliases;
//   - every implementation a call through an interface or base class may reach;
//   - every member a computed key could select (`handlers[kind]()`);
//   - a class's implicit constructor running its base constructor;
//   - importing a module, which runs its top-level code;
//   - a function handing a call an object of functions (`app.route({ handler() {...} })`,
//     or a const holding one): the callee can call any of them, like a function passed to it;
//   - a decorator, which runs where the class is defined (a member's is charged to the member).

import { Node, SyntaxKind, ts, VariableDeclarationKind, type ClassDeclaration, type ClassExpression, type Identifier, type SourceFile, type Type } from "ts-morph";
import type { AdapterIndex } from "./adapters.js";
import { UNVERIFIABLE, formatCapability, type Capability } from "./capability.js";
import { classifyComputedCall, computedCallee } from "./detect/computed.js";
import { loadOf, loadTarget } from "./detect/modules.js";
import { callText, literalString, resolveAlias, resolvedDeclaration, unwrapExpression, type CallLike } from "./detect/shared.js";
import { descendantsOfKind, forEachDescendant, lineAndColumn } from "./walk.js";
import type { Hierarchy } from "./dispatch.js";
import {
  constructorUnitNode,
  enclosingUnitNode,
  objectsHandedToCalls,
  unitNodeForDeclaration,
  unitNodeForSymbol,
  unitNodesForSymbol,
  type Unit,
  type Use,
} from "./units.js";

export interface Edge {
  from: Unit;
  to: Unit;
  /** The call or expression that reaches `to`, as written. */
  call: string;
  line: number;
  column: number;
}

export interface GraphContext {
  unitOf: (node: Node) => Unit | undefined;
  /** A file's units that code outside it can reach: its top level, and what it exports. */
  exportedUnits: (file: SourceFile) => readonly Unit[];
  hierarchy: Hierarchy;
  adapters: AdapterIndex;
}

export function collectEdges(sourceFile: SourceFile, ctx: GraphContext): Edge[] {
  const edges: Edge[] = [];
  const add = (fromNode: Node, target: Node | undefined, site: Node, text: string) => {
    const from = ctx.unitOf(enclosingUnitNode(fromNode));
    const to = target && ctx.unitOf(target);
    if (!from || !to) return;
    const { line, column } = lineAndColumn(sourceFile, site.getStart());
    edges.push({ from, to, call: text, line, column });
  };
  const addFromModule = (target: Node | undefined, site: Node) => {
    const from = ctx.unitOf(sourceFile);
    const to = target && ctx.unitOf(target);
    if (!from || !to) return;
    const { line, column } = lineAndColumn(sourceFile, site.getStart());
    edges.push({ from, to, call: site.getText().replace(/\s+/g, " "), line, column });
  };

  // References.
  for (const id of descendantsOfKind(sourceFile, SyntaxKind.Identifier)) {
    const symbol = referencedSymbol(id);
    if (!symbol) continue;
    const site = referenceSite(id);
    const text = Node.isCallExpression(site) || Node.isNewExpression(site) ? callText(site) : site.getText();
    const resolved = resolveAlias(symbol);
    // All of the symbol's units: `b.value = 2` runs the setter, not the getter that shares its name.
    for (const target of unitNodesForSymbol(resolved)) add(id, target, site, text);
    // A member read through an interface or base class (`s.url`, `urls.map(s.send)`,
    // `s.send.call(...)`) may be any implementation's.
    for (const d of resolved.getDeclarations()) for (const impl of ctx.hierarchy.implementations(d)) add(id, impl, site, text);
  }

  // An object of functions a function hands to a call: `app.route({ url, handler(q) {...} })`,
  // or a const holding one, `app.use(routes)`. (Handed out by the file's top-level code,
  // they're entry points instead; see units.ts.)
  for (const { call, members } of objectsHandedToCalls(sourceFile)) {
    if (Node.isSourceFile(enclosingUnitNode(call))) continue;
    for (const member of members) add(call, member, call, callText(call));
  }

  // Property reads that run getters without an `a.b`: `const { g } = b`, `({ g } = b)`, `b["g"]`, `{ ...b }`.
  const addMembers = (from: Node, type: Type, names: (name: string) => boolean, text: string, gettersOnly = false) => {
    for (const property of type.getProperties()) {
      if (!names(property.getName())) continue;
      for (const d of property.getDeclarations()) {
        for (const target of [unitNodeForDeclaration(d), ...ctx.hierarchy.implementations(d)]) {
          if (!gettersOnly || (target && Node.isGetAccessorDeclaration(target))) add(from, target, from, text);
        }
      }
    }
  };
  const named = (name: string | undefined) => (n: string) => name === undefined || n === name;
  for (const element of descendantsOfKind(sourceFile, SyntaxKind.BindingElement)) {
    const pattern = element.getParent();
    if (!Node.isObjectBindingPattern(pattern)) continue;
    // `...rest` copies every property, running every getter; so may a computed key.
    const name = element.getDotDotDotToken() ? undefined : propertyKey(element.getPropertyNameNode() ?? element.getNameNode());
    addMembers(element, pattern.getType(), named(name), element.getText());
  }
  for (const access of descendantsOfKind(sourceFile, SyntaxKind.ElementAccessExpression)) {
    const key = literalString(access.getArgumentExpression());
    if (key !== undefined) addMembers(access, access.getExpression().getType(), (n) => n === key, access.getText());
  }
  // Copying an object runs its getters: `{ ...b }`.
  for (const spread of descendantsOfKind(sourceFile, SyntaxKind.SpreadAssignment)) {
    if (isAssignmentTarget(spread.getParentOrThrow())) continue;
    addMembers(spread, spread.getExpression().getType(), named(undefined), spread.getText(), true);
  }

  // Methods the language calls implicitly.
  const iterator = (n: string) => n.startsWith("__@iterator") || n.startsWith("__@asyncIterator");
  for (const node of descendantsOfKind(sourceFile, SyntaxKind.AwaitExpression)) {
    addMembers(node, node.getExpression().getType(), (n) => n === "then", shortText(node));
  }
  const toPrimitive = (n: string) => n === "toString" || n === "valueOf" || n.startsWith("__@toPrimitive");
  for (const template of descendantsOfKind(sourceFile, SyntaxKind.TemplateExpression)) {
    for (const span of template.getTemplateSpans()) addMembers(span, span.getExpression().getType(), toPrimitive, shortText(template));
  }
  // Arithmetic, comparisons, `+`, and `==` convert objects to primitives: `o * 2`, `"x" + o`, `s += o`.
  const convert = (node: Node, operand: Node) => {
    // An operator's result is already a primitive. (Asking TypeScript for its type would
    // check the whole expression again: in `a + b + c + ...`, once per term.)
    if (isOperatorResult(operand)) return;
    const type = operand.getType();
    // (A primitive's methods are all in the standard library: skip looking them up.)
    if ((type.getFlags() & PRIMITIVE) === 0) addMembers(node, type, toPrimitive, shortText(node));
  };
  for (const binary of descendantsOfKind(sourceFile, SyntaxKind.BinaryExpression)) {
    const operator = binary.getOperatorToken().getKind();
    if (CONVERTING.has(operator)) for (const operand of [binary.getLeft(), binary.getRight()]) convert(binary, operand);
    // `x instanceof K` runs K's static [Symbol.hasInstance].
    if (operator === SyntaxKind.InstanceOfKeyword) {
      addMembers(binary, binary.getRight().getType(), (n) => n.startsWith("__@hasInstance"), shortText(binary));
    }
    // `({ g } = b)` reads b.g, like `const { g } = b`; `[x] = b` iterates b.
    const target = binary.getLeft();
    if (operator === SyntaxKind.EqualsToken && Node.isObjectLiteralExpression(target)) {
      for (const p of target.getProperties()) {
        const name = Node.isSpreadAssignment(p) ? undefined : propertyKey(p.getNameNode());
        addMembers(p, binary.getRight().getType(), named(name), p.getText());
      }
    }
    if (operator === SyntaxKind.EqualsToken && Node.isArrayLiteralExpression(target)) {
      addMembers(binary, binary.getRight().getType(), iterator, shortText(binary));
    }
  }
  for (const unary of [...descendantsOfKind(sourceFile, SyntaxKind.PrefixUnaryExpression), ...descendantsOfKind(sourceFile, SyntaxKind.PostfixUnaryExpression)]) {
    if (unary.getOperatorToken() !== SyntaxKind.ExclamationToken) convert(unary, unary.getOperand());
  }
  for (const loop of descendantsOfKind(sourceFile, SyntaxKind.ForOfStatement)) {
    addMembers(loop, loop.getExpression().getType(), iterator, `for (... of ${loop.getExpression().getText()})`);
  }
  for (const spread of descendantsOfKind(sourceFile, SyntaxKind.SpreadElement)) {
    addMembers(spread, spread.getExpression().getType(), iterator, spread.getText());
  }
  for (const pattern of descendantsOfKind(sourceFile, SyntaxKind.ArrayBindingPattern)) {
    addMembers(pattern, pattern.getType(), iterator, pattern.getText());
  }
  for (const yieldStar of descendantsOfKind(sourceFile, SyntaxKind.YieldExpression)) {
    const delegated = yieldStar.getExpression();
    if (yieldStar.getAsteriskToken() && delegated) addMembers(yieldStar, delegated.getType(), iterator, shortText(yieldStar));
  }
  // `using r = ...` runs r[Symbol.dispose]() when the block ends; `await using`, [Symbol.asyncDispose]().
  for (const list of descendantsOfKind(sourceFile, SyntaxKind.VariableDeclarationList)) {
    const kind = list.getDeclarationKind();
    if (kind !== VariableDeclarationKind.Using && kind !== VariableDeclarationKind.AwaitUsing) continue;
    const disposes = (n: string) => n.startsWith("__@dispose") || (kind === VariableDeclarationKind.AwaitUsing && n.startsWith("__@asyncDispose"));
    for (const declaration of list.getDeclarations()) addMembers(declaration, declaration.getType(), disposes, shortText(declaration));
  }

  // Calls: the resolved declaration, dispatch to implementations, computed members.
  forEachDescendant(sourceFile, (node) => {
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node) && !Node.isTaggedTemplateExpression(node)) return;
    const call: CallLike = node;
    const text = callText(call);

    // require(x) and import(x) run the module's top level. When TypeScript types the result,
    // calls on it resolve; when it's `any`, any of the module's exports could be called.
    const load = loadOf(call);
    if (load) {
      const [argument] = load.call.getArguments();
      const literal = argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) ? moduleOf(argument) : undefined;
      const target = literal ? undefined : loadTarget(load, ctx.adapters);
      const file = literal ?? (target?.kind === "file" ? target.file : undefined);
      add(call, file, call, text);
      if (load.untyped && file && Node.isSourceFile(file)) for (const unit of ctx.exportedUnits(file)) add(call, unit.node, call, text);
      return;
    }

    // super(...) runs the base constructor, explicit or implicit (an implicit one resolves to no declaration).
    if (Node.isCallExpression(call) && call.getExpression().getKind() === SyntaxKind.SuperKeyword) {
      const cls = call.getFirstAncestor((a) => Node.isClassDeclaration(a) || Node.isClassExpression(a));
      for (const base of cls && (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) ? baseClasses(cls) : []) {
        add(call, constructorUnitNode(base), call, text);
      }
    }
    // `new K()` where K holds a class built by an expression (`const K = make()`, a mixin):
    // its type names the class, even with no declaration to resolve to.
    if (Node.isNewExpression(call)) for (const cls of constructedClasses(call.getExpression())) add(call, constructorUnitNode(cls), call, text);

    const declaration = resolvedDeclaration(call);
    if (declaration) {
      add(call, unitNodeForDeclaration(declaration), call, text);
      for (const impl of ctx.hierarchy.implementations(declaration)) add(call, impl, call, text);
    }

    const computed = computedCallee(call);
    const target = computed && classifyComputedCall(computed, ctx.adapters);
    if (target?.kind === "members") {
      for (const member of target.members) {
        for (const d of member.getDeclarations()) {
          add(call, unitNodeForDeclaration(d) ?? valueUnit(d), call, text);
          for (const impl of ctx.hierarchy.implementations(d)) add(call, impl, call, text);
        }
      }
    }
  });

  // An implicit constructor runs the base class's constructor (`extends Base`, or a mixin's class).
  for (const cls of [...descendantsOfKind(sourceFile, SyntaxKind.ClassDeclaration), ...descendantsOfKind(sourceFile, SyntaxKind.ClassExpression)]) {
    if (constructorUnitNode(cls) !== cls) continue;
    const from = ctx.unitOf(cls)!;
    const { line, column } = lineAndColumn(sourceFile, cls.getStart());
    for (const base of baseClasses(cls)) {
      // A library's class (`extends EventEmitter`) has no unit.
      const to = ctx.unitOf(constructorUnitNode(base));
      if (to) edges.push({ from, to, call: `extends ${shortText(cls.getExtends()!.getExpression())}`, line, column });
    }
  }

  // Imports and re-exports run the target module's top level, and so does `import x = require("y")`.
  for (const decl of [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]) {
    if (decl.isTypeOnly()) continue;
    addFromModule(decl.getModuleSpecifierSourceFile(), decl);
  }
  for (const decl of descendantsOfKind(sourceFile, SyntaxKind.ImportEqualsDeclaration)) {
    if (!decl.isTypeOnly() && Node.isExternalModuleReference(decl.getModuleReference())) addFromModule(decl.getExternalModuleReferenceSourceFile(), decl);
  }
  return edges;
}

/** The classes a value of this expression's type constructs: a class, or the classes a mixin combines. */
function constructedClasses(expression: Node): (ClassDeclaration | ClassExpression)[] {
  const type = expression.getType();
  const parts = type.isIntersection() ? type.getIntersectionTypes() : type.isUnion() ? type.getUnionTypes() : [type];
  return parts.flatMap((t) => (t.getSymbol()?.getDeclarations() ?? []).filter((d) => Node.isClassDeclaration(d) || Node.isClassExpression(d)));
}

/** The classes a class extends: `extends Base`, or what `extends Mixin(Base)` returns. */
function baseClasses(cls: ClassDeclaration | ClassExpression): (ClassDeclaration | ClassExpression)[] {
  const heritage = cls.getExtends()?.getExpression();
  return heritage ? constructedClasses(heritage) : [];
}

/** The symbol an identifier refers to as a value, or undefined if it isn't a value reference. */
function referencedSymbol(id: Identifier) {
  const parent = id.getParent();
  // `{ helper }` passes the local `helper`.
  if (parent && Node.isShorthandPropertyAssignment(parent)) return isInValuePosition(id) ? parent.getValueSymbol() : undefined;
  return isValueReference(id) ? id.getSymbol() : undefined;
}

/** A property whose value names a function: `notify: sendAlert`. */
function valueUnit(declaration: Node): Node | undefined {
  if (!Node.isPropertyAssignment(declaration)) return undefined;
  const symbol = declaration.getInitializer()?.getSymbol();
  return symbol ? unitNodeForSymbol(resolveAlias(symbol)) : undefined;
}

/** The source file a module specifier (an import() argument) resolves to. */
function moduleOf(specifier: Node): Node | undefined {
  const declaration = specifier.getSymbol()?.getDeclarations()[0];
  return declaration && Node.isSourceFile(declaration) ? declaration : undefined;
}

function isInValuePosition(id: Identifier): boolean {
  for (const ancestor of id.getAncestors()) {
    if (Node.isTypeNode(ancestor) || Node.isJSDoc(ancestor)) return false;
    if (Node.isStatement(ancestor)) break;
  }
  return true;
}

function isValueReference(id: Identifier): boolean {
  const parent = id.getParent();
  // The name being declared is not a reference to it. (`a.f` also has a name node, but is a
  // reference, and so is a decorator's: `@logged` calls logged.)
  if (
    parent &&
    !Node.isPropertyAccessExpression(parent) &&
    !Node.isDecorator(parent) &&
    "getNameNode" in parent &&
    (parent as { getNameNode(): Node }).getNameNode() === id
  ) {
    return false;
  }
  for (const ancestor of id.getAncestors()) {
    if (Node.isTypeNode(ancestor) || Node.isJSDoc(ancestor) || Node.isImportDeclaration(ancestor) || Node.isExportDeclaration(ancestor)) {
      return false;
    }
    // `export default handler` exports it (see units.ts) without running it; in
    // `export default withAuth(handler)`, it's handed to a call like any other reference.
    if (Node.isExportAssignment(ancestor)) return unwrapExpression(ancestor.getExpression()) !== id;
    if (Node.isStatement(ancestor)) break;
  }
  return true;
}

/** The call a reference sits in: the call itself for `f()` / `a.f()`, the outer call for `map(f)`. */
function referenceSite(id: Identifier): Node {
  let node: Node = id;
  const parent = node.getParent();
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) node = parent;
  const call = node.getParent();
  if (call && (Node.isCallExpression(call) || Node.isNewExpression(call))) return call;
  return id;
}

// --- propagation -------------------------------------------------------------

/** How a unit came to have a capability: used directly, or reached through an edge. */
export type Provenance = { capability: Capability; use: Use; edge?: undefined } | { capability: Capability; edge: Edge };

/** Every capability each unit can reach, keyed by its formatted form. */
export type Reach = Map<Unit, Map<string, Provenance>>;

/**
 * What every unit can reach. Linear in the size of the graph: units are grouped into
 * strongly connected components (functions that call each other, directly or not), and
 * the components are visited callees first, so each one is finished once. A unit takes
 * each capability through the first call, in source order, that reaches it.
 */
export function propagate(units: Iterable<Unit>, edges: readonly Edge[]): Reach {
  const reach: Reach = new Map();
  const ensure = (unit: Unit) => {
    if (reach.has(unit)) return;
    const own = new Map<string, Provenance>();
    for (const use of unit.uses) {
      const key = formatCapability(use.capability);
      if (!own.has(key)) own.set(key, { capability: use.capability, use });
    }
    reach.set(unit, own);
  };
  for (const unit of units) ensure(unit);
  const outgoing = new Map<Unit, Edge[]>();
  for (const edge of edges) {
    ensure(edge.from);
    ensure(edge.to);
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.line - b.line || a.column - b.column);

  // @perm-unsafe vouches for code the checker can't see; that doesn't fail its callers.
  const carries = (edge: Edge, key: string) => key !== UNVERIFIABLE || !edge.to.own?.unsafe;

  for (const component of componentsCalleesFirst([...reach.keys()], outgoing)) {
    const inside = new Set(component);
    // What the component's units reach through calls out of it, all finished already.
    for (const unit of component) {
      const into = reach.get(unit)!;
      for (const edge of outgoing.get(unit) ?? []) {
        if (inside.has(edge.to)) continue;
        for (const [key, p] of reach.get(edge.to)!) {
          if (!into.has(key) && carries(edge, key)) into.set(key, { capability: p.capability, edge });
        }
      }
    }
    if (component.length === 1 && !(outgoing.get(component[0]!) ?? []).some((e) => e.to === component[0])) continue;
    // Recursion: spread each capability through the component breadth first, so every
    // provenance points one step closer to the use, and paths can't loop.
    const callers = new Map<Unit, Edge[]>();
    for (const unit of component) {
      // (In a cycle, every unit calls another, and is called by one.)
      for (const edge of outgoing.get(unit)!) {
        if (!inside.has(edge.to)) continue;
        const list = callers.get(edge.to);
        if (list) list.push(edge);
        else callers.set(edge.to, [edge]);
      }
    }
    const keys = new Set(component.flatMap((u) => [...reach.get(u)!.keys()]));
    for (const key of keys) {
      const queue = component.filter((u) => reach.get(u)!.has(key));
      for (let i = 0; i < queue.length; i++) {
        const p = reach.get(queue[i]!)!.get(key)!;
        for (const edge of callers.get(queue[i]!)!) {
          const into = reach.get(edge.from)!;
          if (into.has(key) || !carries(edge, key)) continue;
          into.set(key, { capability: p.capability, edge });
          queue.push(edge.from);
        }
      }
    }
  }
  return reach;
}

/** Strongly connected components (Tarjan's algorithm, without recursion), each after every component it calls into. */
function componentsCalleesFirst(units: readonly Unit[], outgoing: ReadonlyMap<Unit, readonly Edge[]>): Unit[][] {
  const index = new Map<Unit, number>();
  const low = new Map<Unit, number>();
  const stack: Unit[] = [];
  const onStack = new Set<Unit>();
  const out: Unit[][] = [];
  const visit = (unit: Unit) => {
    index.set(unit, index.size);
    low.set(unit, index.get(unit)!);
    stack.push(unit);
    onStack.add(unit);
  };
  for (const root of units) {
    if (index.has(root)) continue;
    visit(root);
    const frames: { unit: Unit; next: number }[] = [{ unit: root, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = outgoing.get(frame.unit) ?? [];
      if (frame.next < edges.length) {
        const to = edges[frame.next++]!.to;
        if (!index.has(to)) {
          visit(to);
          frames.push({ unit: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.unit, Math.min(low.get(frame.unit)!, index.get(to)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.unit, Math.min(low.get(parent.unit)!, low.get(frame.unit)!));
      if (low.get(frame.unit) !== index.get(frame.unit)) continue;
      const component: Unit[] = [];
      for (let member = stack.pop()!; ; member = stack.pop()!) {
        onStack.delete(member);
        component.push(member);
        if (member === frame.unit) break;
      }
      out.push(component.reverse());
    }
  }
  return out;
}

// Paths in messages keep their first steps and their last ones: a chain thousands of
// functions deep can't be read, and listing it for every function would take forever.
const HEAD = 20;
const TAIL = 3;

/** A chain to a use, as shown: its length, its first HEAD and last TAIL entries, and the unit that uses it. */
interface Chain {
  length: number;
  head: string[];
  tail: string[];
  holder: Unit;
}

const chains = new WeakMap<Reach, Map<Unit, Map<string, Chain>>>();

function chainOf(reach: Reach, unit: Unit, key: string): Chain | undefined {
  let memo = chains.get(reach);
  if (!memo) chains.set(reach, (memo = new Map()));
  const known = (u: Unit) => memo.get(u)?.get(key);
  // Walk to the use, or to a chain already worked out, then fill in the way back.
  const walked: { unit: Unit; p: Provenance }[] = [];
  for (let u: Unit | undefined = unit; u && !known(u); ) {
    const p: Provenance | undefined = reach.get(u)?.get(key);
    if (!p) break;
    walked.push({ unit: u, p });
    u = p.edge?.to;
  }
  for (let i = walked.length - 1; i >= 0; i--) {
    const { unit: u, p } = walked[i]!;
    let chain: Chain;
    if (!p.edge) chain = { length: 1, head: [p.use.call], tail: [p.use.call], holder: u };
    else {
      const next = known(p.edge.to)!;
      const name = p.edge.to.name;
      chain = {
        length: next.length + 1,
        head: [name, ...next.head.slice(0, HEAD - 1)],
        tail: next.length >= TAIL ? next.tail : [name, ...next.tail],
        holder: next.holder,
      };
    }
    if (!memo.has(u)) memo.set(u, new Map());
    memo.get(u)!.set(key, chain);
  }
  return known(unit);
}

/** The chain from `unit` to the call that uses `key`, e.g. ["b", "c", 'writeFileSync(...)']; very long ones are shortened. */
export function pathTo(reach: Reach, unit: Unit, key: string): string[] {
  const chain = chainOf(reach, unit, key);
  if (!chain) return [];
  if (chain.length <= HEAD + TAIL) return [...chain.head, ...chain.tail.slice(chain.tail.length - (chain.length - chain.head.length))];
  return [...chain.head, `… ${chain.length - HEAD - TAIL} more …`, ...chain.tail];
}

/** The unit whose own code uses `key`: `unit` itself, or the last one on the chain from it. */
export function holderOf(reach: Reach, unit: Unit, key: string): Unit {
  return chainOf(reach, unit, key)?.holder ?? unit;
}

const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike |
  ts.TypeFlags.EnumLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;

// Operators that convert their operands to primitives (`===`, `&&`, `??` and the like don't).
const CONVERTING = new Set([
  SyntaxKind.PlusToken, SyntaxKind.MinusToken, SyntaxKind.AsteriskToken, SyntaxKind.SlashToken, SyntaxKind.PercentToken,
  SyntaxKind.AsteriskAsteriskToken, SyntaxKind.LessThanToken, SyntaxKind.GreaterThanToken, SyntaxKind.LessThanEqualsToken,
  SyntaxKind.GreaterThanEqualsToken, SyntaxKind.EqualsEqualsToken, SyntaxKind.ExclamationEqualsToken, SyntaxKind.AmpersandToken,
  SyntaxKind.BarToken, SyntaxKind.CaretToken, SyntaxKind.LessThanLessThanToken, SyntaxKind.GreaterThanGreaterThanToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanToken, SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken, SyntaxKind.SlashEqualsToken, SyntaxKind.PercentEqualsToken, SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AmpersandEqualsToken, SyntaxKind.BarEqualsToken, SyntaxKind.CaretEqualsToken, SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken, SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

/** The property a destructuring key names: `data`, `"data"`, `0`, `[KEY]` with a literal KEY; undefined when it can't be known. */
function propertyKey(name: Node): string | undefined {
  if (Node.isComputedPropertyName(name)) return literalString(name.getExpression());
  return Node.isStringLiteral(name) || Node.isNumericLiteral(name) ? name.getLiteralText() : name.getText();
}

/** The first 60 characters of a node's code, without reading all of it. */
function shortText(node: Node): string {
  const start = node.getStart();
  return node.getSourceFile().getFullText().slice(start, Math.min(node.getEnd(), start + 60));
}

/** `a + b`, `-a`, `typeof a`, a literal: the value is a primitive, whatever the operands were. */
function isOperatorResult(expression: Node): boolean {
  const node = unwrapExpression(expression);
  if (Node.isBinaryExpression(node)) return !OBJECT_PRESERVING.has(node.getOperatorToken().getKind());
  return (
    Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node) || Node.isTypeOfExpression(node) ||
    Node.isVoidExpression(node) || Node.isDeleteExpression(node) || Node.isLiteralExpression(node) || Node.isTemplateExpression(node)
  );
}

// Operators whose result can be an operand itself, so an object.
const OBJECT_PRESERVING = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken,
  SyntaxKind.CommaToken, SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.QuestionQuestionEqualsToken,
]);

/** The left side of `=`: `({ a } = b)` destructures rather than builds an object. */
function isAssignmentTarget(node: Node): boolean {
  const parent = node.getParentOrThrow();
  return Node.isBinaryExpression(parent) && parent.getLeft() === node && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}
