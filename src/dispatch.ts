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

import { Node, SyntaxKind, ts, type ClassDeclaration, type ClassExpression, type ObjectLiteralExpression, type SourceFile, type Type } from "ts-morph";
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

  constructor(sourceFiles: readonly SourceFile[]) {
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
