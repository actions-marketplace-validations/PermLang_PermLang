// Dynamic dispatch. A call through an interface, a base class, or a structural
// type may run any implementation of that member. This charges the caller with
// every first-party implementation:
//   - methods, accessors, and function-valued fields of classes that extend or
//     implement the declaring type (directly or through other classes, interfaces,
//     and type aliases);
//   - members of object literals whose contextual type is the declaring type
//     (`const n: Notifier = { notify: ... }`, or an argument passed to a
//     parameter of that type);
//   - for an interface or object type (not a class), every class and object literal
//     that could stand in for it, written against it or not: TypeScript's types are
//     structural, so `class Real { send() {} }` is a `Sender` without saying so.
// A member is a method, an accessor, or a property (`send: (u) => void`, `readonly url: string`),
// reached by calling it, reading it, or passing it on (`urls.map(s.send)`).
// Functions attached after the fact (`obj.m = fn`) are not found: a known limit.
//
// A call through a function type can run more than one function too, when the type is a
// callable interface or type alias (`interface Runner { (cmd: string): void }`,
// `type Runner = (cmd: string) => void`), or the type of a collection's entries
// (`Map<string, (cmd: string) => void>`, `Handler[]`, or one TypeScript inferred from a
// function in it: `new Map([["run", (cmd: string) => ...]])`). It's charged with every
// function written against that type: one whose contextual type it is (`const r: Runner =
// (cmd) => ...`, an entry of the collection, `ops.set("x", (cmd) => ...)`), or a named
// function put where it's expected (`ops.set("x", run)`). A function that merely fits isn't
// counted, unlike a class that fits an interface: nearly every function fits a call signature.
// A function type written for a parameter isn't one of these: a callback runs as part of the
// code that passes it, which is charged with it already.

import { Node, SyntaxKind, ts, type ClassDeclaration, type ClassExpression, type Expression, type Identifier, type ObjectLiteralExpression, type SourceFile, type Type } from "ts-morph";
import { resolveAlias } from "./detect/shared.js";
import { isInNodeModules, unitNodeForDeclaration, unitNodeForSymbol } from "./units.js";
import { descendantsOfKind } from "./walk.js";

type ClassNode = ClassDeclaration | ClassExpression;
type Implementer = ClassNode | ObjectLiteralExpression;

export class Hierarchy {
  private readonly classes: { cls: ClassNode; ancestors: Set<Node> }[] = [];
  private readonly literals = new Map<Node, ObjectLiteralExpression[]>();
  /** Classes and object literals by the names of the members they implement with code. */
  private readonly byMember = new Map<string, Implementer[]>();
  private readonly cache = new Map<Node, Node[]>();
  /** Functions written against each function type that's dispatched, found when a call first needs them. */
  private written: Map<Node, Node[]> | undefined;

  constructor(private readonly sourceFiles: readonly SourceFile[]) {
    for (const sf of sourceFiles) {
      for (const cls of [...descendantsOfKind(sf, SyntaxKind.ClassDeclaration), ...descendantsOfKind(sf, SyntaxKind.ClassExpression)]) {
        this.classes.push({ cls, ancestors: classAncestors(cls) });
        for (const m of cls.getMembers()) if (!isStatic(m)) this.index(m, cls);
      }
      for (const literal of descendantsOfKind(sf, SyntaxKind.ObjectLiteralExpression)) {
        for (const type of contextualTypeDeclarations(literal)) {
          for (const t of [type, ...typeAncestors(type)]) push(this.literals, t, literal);
        }
        for (const p of literal.getProperties()) this.index(p, literal);
      }
    }
  }

  private index(member: Node, owner: Implementer): void {
    const name = memberName(member);
    if (name !== undefined && implementationUnit(member)) push(this.byMember, name, owner);
  }

  /** Unit nodes that a call to `member` (or a read of it, for a property) might run, beyond the declaration itself. */
  implementations(member: Node): Node[] {
    if (memberName(member) === undefined) return [];
    const cached = this.cache.get(member);
    if (cached) return cached;
    const out = this.find(member);
    this.cache.set(member, out);
    return out;
  }

  private find(member: Node): Node[] {
    const container = containerOf(member);
    const name = memberName(member);
    if (!container || name === undefined || !isFirstParty(container)) return [];

    const out = new Set<Node>();
    const add = (owner: Implementer) => {
      const members = Node.isObjectLiteralExpression(owner) ? owner.getProperties() : owner.getMembers().filter((m) => !isStatic(m));
      for (const m of members) {
        const unit = memberName(m) === name ? implementationUnit(m) : undefined;
        if (unit) out.add(unit);
      }
    };
    for (const { cls, ancestors } of this.classes) if (ancestors.has(container)) add(cls);
    for (const literal of this.literals.get(container) ?? []) add(literal);

    // An interface or object type (not a class, or one particular object): anything that can stand in for it.
    if (Node.isInterfaceDeclaration(container) || Node.isTypeAliasDeclaration(container) || Node.isTypeLiteral(container)) {
      const target = container.getType();
      const fits = structuralTest(container, target);
      for (const candidate of this.byMember.get(name) ?? []) if (fits(candidate)) add(candidate);
    }
    out.delete(member);
    return [...out];
  }

  /**
   * The functions a call whose signature `declaration` declares might run, beyond the
   * declaration itself: for a dispatched function type (see above), the functions written
   * against it, and an anonymous function the type was inferred from. Each is a unit node,
   * or an anonymous function, which stands for the part of its unit inside it (check.ts).
   */
  functionsCalledThrough(declaration: Node): Node[] {
    if (!isDispatchedSignature(declaration)) return [];
    const cached = this.cache.get(declaration);
    if (cached) return cached;
    const own = Node.isArrowFunction(declaration) || Node.isFunctionExpression(declaration) ? [declaration] : [];
    const out = [...new Set([...own, ...(this.writtenAgainst().get(declaration) ?? [])])];
    this.cache.set(declaration, out);
    return out;
  }

  private writtenAgainst(): Map<Node, Node[]> {
    if (this.written) return this.written;
    const written = new Map<Node, Node[]>();
    const add = (expression: Expression, fn: Node) => {
      for (const signature of contextualSignatures(expression)) if (isDispatchedSignature(signature)) push(written, signature, fn);
    };
    for (const sf of this.sourceFiles) {
      for (const fn of [...descendantsOfKind(sf, SyntaxKind.ArrowFunction), ...descendantsOfKind(sf, SyntaxKind.FunctionExpression)]) {
        add(fn, unitNodeForDeclaration(fn) ?? fn);
      }
      for (const id of descendantsOfKind(sf, SyntaxKind.Identifier)) {
        const reference = functionPassed(id);
        if (reference) add(reference.expression, reference.unit);
      }
    }
    return (this.written = written);
  }
}

/**
 * Whether a call through this signature declaration is dispatched: a call signature or
 * function type of the project's that's a callable interface or type alias, or the type of a
 * collection's entries; or an anonymous function of the project's that the callee's type was
 * inferred from (`new Map([["run", (cmd: string) => ...]])`, or one a function returns). Not a
 * function held by a name, which a call by that name runs alone.
 */
function isDispatchedSignature(declaration: Node): boolean {
  if (!isFirstParty(declaration)) return false;
  if (Node.isArrowFunction(declaration) || Node.isFunctionExpression(declaration)) return unitNodeForDeclaration(declaration) === undefined;
  if (!Node.isCallSignatureDeclaration(declaration) && !Node.isFunctionTypeNode(declaration)) return false;
  // What the type is written for, past parentheses, unions, and (for a call signature) its object type.
  let owner = declaration.getParentOrThrow();
  while (Node.isParenthesizedTypeNode(owner) || Node.isUnionTypeNode(owner) || Node.isIntersectionTypeNode(owner) || Node.isTypeLiteral(owner)) owner = owner.getParentOrThrow();
  if (Node.isInterfaceDeclaration(owner) || Node.isTypeAliasDeclaration(owner)) return true;
  // A collection's entries, unless the collection is a parameter's: like a callback, what's in
  // it runs as part of the code that passes it, which is charged with it already.
  return COLLECTIONS.has(owner.getKind()) && !Node.isParameterDeclaration(annotated(declaration));
}

// Where a function type is a collection's entries: a type argument (`Map<string, F>`,
// `new Map<string, F>()`), an array or tuple, or an index signature. A variable's, property's,
// or return type of its own is left out: one function, held by a name.
const COLLECTIONS = new Set([
  SyntaxKind.TypeReference, SyntaxKind.ExpressionWithTypeArguments, SyntaxKind.NewExpression, SyntaxKind.CallExpression,
  SyntaxKind.ArrayType, SyntaxKind.TupleType, SyntaxKind.NamedTupleMember, SyntaxKind.RestType, SyntaxKind.OptionalType, SyntaxKind.IndexSignature,
]);

/** What a type is written for: the parameter, variable, or other declaration whose type it's part of. */
function annotated(type: Node): Node {
  let node = type.getParentOrThrow();
  while (Node.isTypeNode(node) || Node.isPropertySignature(node) || Node.isIndexSignatureDeclaration(node) || Node.isMethodSignature(node)) node = node.getParentOrThrow();
  return node;
}

/**
 * The declarations of the call signatures of an expression's contextual type: what it's
 * written against. These are found for the whole project when one call needs them, so an
 * expression TypeScript fails on (nested too deeply, say) is left out, as a call it fails to
 * resolve is (shared.ts), rather than failing the file whose call needed them.
 */
function contextualSignatures(expression: Expression): Node[] {
  try {
    const type = expression.getContextualType()?.getNonNullableType();
    if (!type) return [];
    const parts = type.isUnion() ? type.getUnionTypes() : [type];
    return parts.flatMap((t) => t.getCallSignatures().map((s) => s.getDeclaration()));
  } catch {
    return [];
  }
}

/**
 * A function of the project's named, not called, where its contextual type decides what it
 * is: an argument (`ops.set("x", run)`), an entry (`[run]`), a value (`{ go: run }`,
 * `const r: Runner = run`, `r = run`, `return run`), or what's cast (`run as Runner`).
 */
function functionPassed(id: Identifier): { expression: Expression; unit: Node } | undefined {
  const parent = id.getParentOrThrow();
  // `api.run` stands for the whole access; `api` in it is an object, not a function passed.
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === id) return undefined;
  const expression = Node.isPropertyAccessExpression(parent) ? parent : id;
  if (!isContextuallyTyped(expression)) return undefined;
  const symbol = id.getSymbol();
  const unit = symbol && unitNodeForSymbol(resolveAlias(symbol));
  if (!unit || !isFunctionUnit(unit)) return undefined;
  return { expression, unit };
}

function isContextuallyTyped(expression: Node): boolean {
  const outer = expression.getParentOrThrow();
  if (Node.isCallExpression(outer) || Node.isNewExpression(outer)) return (outer.getArguments() as Node[]).includes(expression);
  if (Node.isPropertyAssignment(outer) || Node.isVariableDeclaration(outer)) return outer.getInitializer() === expression;
  if (Node.isBinaryExpression(outer)) return outer.getRight() === expression && outer.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
  if (Node.isArrowFunction(outer)) return outer.getBody() === expression;
  if (Node.isConditionalExpression(outer)) return outer.getWhenTrue() === expression || outer.getWhenFalse() === expression;
  return Node.isArrayLiteralExpression(outer) || Node.isReturnStatement(outer) || Node.isAsExpression(outer) || Node.isSatisfiesExpression(outer);
}

/** A unit that's a function: not a class's constructor, or an accessor, which aren't called as functions are. */
function isFunctionUnit(unit: Node): boolean {
  return !Node.isClassDeclaration(unit) && !Node.isClassExpression(unit) && !Node.isConstructorDeclaration(unit) &&
    !Node.isGetAccessorDeclaration(unit) && !Node.isSetAccessorDeclaration(unit) && !Node.isSourceFile(unit);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Whether a class (its instances) or an object literal can be used as `target`. A generic
 * type can't be compared without its arguments, so for one, having every member it
 * requires is enough.
 */
function structuralTest(container: Node, target: Type): (candidate: Implementer) => boolean {
  const generic = (Node.isInterfaceDeclaration(container) || Node.isTypeAliasDeclaration(container)) && container.getTypeParameters().length > 0;
  if (!generic) return (candidate) => typeOf(candidate)?.isAssignableTo(target) === true;
  const required = target.getProperties().filter((p) => !p.hasFlags(ts.SymbolFlags.Optional)).map((p) => p.getName());
  return (candidate) => {
    const names = new Set(typeOf(candidate)?.getProperties().map((p) => p.getName()));
    return required.every((n) => names.has(n));
  };
}

function typeOf(candidate: Implementer): Type | undefined {
  return Node.isObjectLiteralExpression(candidate) ? candidate.getType() : candidate.getSymbol()?.getDeclaredType();
}

/** Declared in the project (a .ts file or its own .d.ts), not in a package or the standard library. */
function isFirstParty(node: Node): boolean {
  return !isInNodeModules(node.getSourceFile());
}

/** The type a member belongs to: its class or interface, or the type alias an object type is written in. */
function containerOf(member: Node): Node | undefined {
  let container = member.getParent();
  if (container && Node.isTypeLiteral(container)) {
    // `type S = { ... }`, `type S = Base & { ... }`.
    let holder: Node | undefined = container.getParent();
    while (holder && (Node.isIntersectionTypeNode(holder) || Node.isParenthesizedTypeNode(holder))) holder = holder.getParent();
    if (holder && Node.isTypeAliasDeclaration(holder)) container = holder;
  }
  return container;
}

function memberName(node: Node): string | undefined {
  if (
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node) ||
    Node.isPropertyAssignment(node) ||
    Node.isShorthandPropertyAssignment(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return node.getName();
  }
  return undefined;
}

function isStatic(node: Node): boolean {
  return "isStatic" in node && (node as { isStatic(): boolean }).isStatic();
}

/** The unit an implementing member runs: its own body, or the function it names (`notify = send`, `{ send }`). */
function implementationUnit(member: Node): Node | undefined {
  const own = unitNodeForDeclaration(member);
  if (own) return own;
  if (Node.isShorthandPropertyAssignment(member)) {
    const value = member.getValueSymbol();
    return value ? unitNodeForSymbol(resolveAlias(value)) : undefined;
  }
  if (Node.isPropertyAssignment(member) || Node.isPropertyDeclaration(member)) {
    const init = member.getInitializer();
    const symbol = init?.getSymbol();
    return symbol ? unitNodeForSymbol(resolveAlias(symbol)) : undefined;
  }
  return undefined;
}

/** Every class, interface, and type alias a class extends or implements, transitively. */
function classAncestors(cls: ClassNode): Set<Node> {
  const out = new Set<Node>();
  const visit = (node: Node) => {
    if (out.has(node)) return;
    out.add(node);
    for (const next of directBases(node)) visit(next);
  };
  for (const base of directBases(cls)) visit(base);
  return out;
}

function typeAncestors(type: Node): Node[] {
  const out = new Set<Node>();
  const visit = (node: Node) => {
    for (const next of directBases(node)) {
      if (out.has(next)) continue;
      out.add(next);
      visit(next);
    }
  };
  visit(type);
  return [...out];
}

function directBases(node: Node): Node[] {
  const heritage = Node.isClassDeclaration(node) || Node.isClassExpression(node)
    ? [node.getExtends(), ...node.getImplements()]
    : Node.isInterfaceDeclaration(node)
      ? node.getExtends()
      : [];
  return heritage.flatMap((h) => {
    const symbol = h?.getExpression().getSymbol();
    return symbol ? resolveAlias(symbol).getDeclarations() : [];
  });
}

/** The interface, class, or type literal an object literal is written against. */
function contextualTypeDeclarations(literal: ObjectLiteralExpression): Node[] {
  const type = literal.getContextualType();
  if (!type) return [];
  const symbols = [type.getSymbol(), type.getAliasSymbol()].filter((s) => s !== undefined);
  return symbols.flatMap((s) => s.getDeclarations()).filter((d) => isFirstParty(d));
}
