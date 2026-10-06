// The related tables a Prisma query reaches through its arguments: `include`,
// `select`, `where`, and `orderBy` read related models, and nested writes in `data`
// write them. Drizzle's `with` is walked the same way (drizzle.ts).
//
// Relations come from the generated client: every model has a `$<Model>Payload`
// type whose `objects` are its relations, each typed with the related model's own
// payload. Arguments that aren't written out (a variable, a spread, a computed key)
// are checked by their type: one that can't name a relation adds nothing, and
// anything else could reach any table, so it needs bare db.read (and db.write in
// `data`). Without payload types (Prisma 4, hand-written typings) a relation can't
// be told from a plain field, so any argument that could name one is unknown.

import { Node, SyntaxKind, ts, type SourceFile, type Type } from "ts-morph";
import type { Capability } from "../capability.js";
import { literalString, unwrapExpression } from "./shared.js";

/** A model: its table (the client's accessor name) and its payload type, when known. */
export interface Model {
  table: string | undefined;
  payload: Type | undefined;
}

interface Relation {
  model: Model;
  many: boolean;
  /** Whether the foreign key is stored in the related table, so linking a record writes it. */
  keyThere: boolean;
}

type Mode = "read" | "write";

const LOGICAL = new Set(["AND", "OR", "NOT"]);
const RELATION_FILTERS = new Set(["some", "every", "none", "is", "isNot"]);
const LINKS = new Set(["connect", "disconnect", "set"]);
// Keys that hold more arguments, which can name relations in turn.
const STRUCTURAL = new Set([
  ...LOGICAL, ...RELATION_FILTERS, ...LINKS, "where", "include", "select", "orderBy", "cursor", "having", "data",
  "create", "createMany", "connectOrCreate", "upsert", "update", "updateMany", "delete", "deleteMany", "_count",
]);

/** The model whose payload is `$<Name>Payload`, declared in `near` (the generated client). */
export function modelNamed(name: string, near: SourceFile): Model {
  return { table: accessor(name), payload: aliasesIn(near).get(`$${name}Payload`)?.getType() };
}

/** A capability on a table, or on an unknown one. */
export function scoped(name: string, table: string | undefined): Capability {
  return table === undefined ? { name, dynamic: true } : { name, arg: table };
}

/** Prisma's accessor for a model: `UserProfile` is `prisma.userProfile`. */
export function accessor(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** The tables a query's arguments reach besides its own model's: `args` is the first argument of `findMany`, `update`, ... */
export function argumentAccess(args: Node | undefined, model: Model, mode: Mode): Capability[] {
  if (!args) return [];
  const walk = new Walk(args);
  walk.args(args, model, mode);
  return walk.found;
}

/** A relation followed by name, as the fluent API does; undefined when `name` isn't a relation. */
export function relationAccess(name: string, args: Node | undefined, model: Model, at: Node): Capability[] | undefined {
  const relation = relationsOf(model, at)?.get(name);
  if (!relation) return undefined;
  const walk = new Walk(at);
  walk.read(relation.model);
  if (args) walk.args(args, relation.model, "read");
  return walk.found;
}

const MAX_DEPTH = 64;

class Walk {
  readonly found: Capability[] = [];
  private depth = 0;

  constructor(private readonly at: Node) {}

  read(model: Model): void {
    this.found.push(scoped("db.read", model.table));
  }

  write(model: Model): void {
    this.found.push(scoped("db.write", model.table));
  }

  /** Could reach any table: bare db.read, and db.write where it could write. */
  unknown(mode: Mode): void {
    this.found.push({ name: "db.read", dynamic: true });
    if (mode === "write") this.found.push({ name: "db.write", dynamic: true });
  }

  /** A query's arguments, or a related model's nested ones. */
  args(node: Node, model: Model, mode: Mode): void {
    this.object(node, model, mode, (key, value) => {
      if (key === "where" || key === "cursor" || key === "having") this.where(value, model);
      else if (key === "include" || key === "select") this.selection(value, model);
      else if (key === "orderBy") this.orderBy(value, model);
      else if (key === "data" || key === "create" || key === "update") this.data(value, model);
    });
  }

  where(node: Node, model: Model): void {
    this.each(node, (item) => this.object(item, model, "read", (key, value) => this.filter(key, value, model)));
  }

  /** One field of a where: `{ posts: { some: {...} } }`, `{ author: { is: {...} } }`, or `{ author: { name: "x" } }`. */
  private filter(key: string, value: Node, model: Model): void {
    if (LOGICAL.has(key)) return this.where(value, model);
    const relation = this.relation(model, key, value, "read", false);
    if (!relation) return;
    this.read(relation.model);
    this.object(value, relation.model, "read", (op, inner) => {
      if (RELATION_FILTERS.has(op)) this.where(inner, relation.model);
      else this.filter(op, inner, relation.model);
    });
  }

  /** `include` or `select`: related models are read, with their own arguments. */
  selection(node: Node, model: Model): void {
    this.object(node, model, "read", (key, value) => {
      if (key === "_count") return this.count(value, model);
      const relation = this.relation(model, key, value, "read", true);
      if (!relation || isFalse(value)) return;
      this.read(relation.model);
      if (!isTrue(value)) this.args(value, relation.model, "read");
    });
  }

  /** `_count: true` counts every relation; `_count: { select: { posts: ... } }` the ones named. */
  private count(node: Node, model: Model): void {
    if (isTrue(node)) {
      const relations = relationsOf(model, this.at);
      if (!relations) return this.unknown("read");
      for (const r of relations.values()) this.read(r.model);
      return;
    }
    this.args(node, model, "read");
  }

  orderBy(node: Node, model: Model): void {
    this.each(node, (item) =>
      this.object(item, model, "read", (key, value) => {
        const relation = this.relation(model, key, value, "read", false);
        if (!relation) return;
        this.read(relation.model);
        this.orderBy(value, relation.model);
      }),
    );
  }

  /** Values to create or update: a relation in them is a nested write. */
  data(node: Node, model: Model): void {
    this.each(node, (item) =>
      this.object(item, model, "write", (key, value) => {
        const relation = this.relation(model, key, value, "write", false);
        if (relation) this.nested(value, relation);
      }),
    );
  }

  /** `{ create: ..., connect: ..., deleteMany: ... }` on a relation. */
  private nested(node: Node, relation: Relation): void {
    const model = relation.model;
    if (!Node.isObjectLiteralExpression(unwrapExpression(node))) this.write(model);
    this.object(node, model, "write", (op, value) => {
      // Linking stores a foreign key: in the related table for a list relation (or
      // in its link table), and for a single relation only when the key is kept there.
      if (LINKS.has(op)) {
        if (relation.many || relation.keyThere) this.write(model);
        else if (op === "connect") this.read(model);
        return this.each(value, (item) => this.where(item, model));
      }
      this.write(model);
      this.each(value, (item) => {
        if (op === "create") return this.data(item, model);
        if (op === "delete" || op === "deleteMany") return this.where(item, model);
        // A single relation's update can be its data, with no `where`.
        if (op === "update" && !hasKey(item, "data") && !hasKey(item, "where")) return this.data(item, model);
        // createMany, connectOrCreate, upsert, update, and updateMany hold arguments.
        this.args(item, model, "write");
      });
    });
  }

  /**
   * The relation `key` names, if any. Without the model's relations, a key might be
   * one, to an unknown table: in `select` and `include` whenever it's selected, and
   * elsewhere unless its value is plain (a string, number, date, ...).
   */
  private relation(model: Model, key: string, value: Node, mode: Mode, selected: boolean): Relation | undefined {
    const relations = relationsOf(model, this.at);
    if (relations) return relations.get(key);
    if (selected ? !isFalse(value) : !isPlainValue(value)) this.unknown(mode);
    return undefined;
  }

  /** Calls `visit` for each property of an object literal. Anything not written out is checked by its type. */
  private object(node: Node, model: Model, mode: Mode, visit: (key: string, value: Node) => void): void {
    const value = unwrapExpression(node);
    if (!Node.isObjectLiteralExpression(value)) {
      if (!isPlainValue(value) && mayNameRelation(value.getType(), relationsOf(model, this.at), this.at)) this.unknown(mode);
      return;
    }
    // Arguments nested deeper than any real query are unknown, which keeps the walk off the stack's limit.
    if (this.depth >= MAX_DEPTH) return this.unknown(mode);
    this.depth++;
    for (const prop of value.getProperties()) {
      const key = propertyKey(prop);
      const initializer = Node.isPropertyAssignment(prop) ? prop.getInitializer() : Node.isShorthandPropertyAssignment(prop) ? prop.getNameNode() : undefined;
      if (key !== undefined && initializer) {
        visit(key, initializer);
      } else if (Node.isSpreadAssignment(prop)) {
        const spread = prop.getExpression();
        if (mayNameRelation(spread.getType(), relationsOf(model, this.at), this.at)) this.unknown(mode);
      } else {
        this.unknown(mode); // a computed key, a getter, a method
      }
    }
    this.depth--;
  }

  /** Each element of an array literal, or the node itself. */
  private each(node: Node, visit: (item: Node) => void): void {
    const value = unwrapExpression(node);
    if (!Node.isArrayLiteralExpression(value)) return visit(value);
    for (const element of value.getElements()) visit(Node.isSpreadElement(element) ? element.getExpression() : element);
  }
}

/** A property's key when it is written out: `posts`, `"posts"`, `["posts"]`. */
function propertyKey(prop: Node): string | undefined {
  if (Node.isShorthandPropertyAssignment(prop)) return prop.getName();
  if (!Node.isPropertyAssignment(prop)) return undefined;
  const name = prop.getNameNode();
  if (Node.isComputedPropertyName(name)) return literalString(unwrapExpression(name.getExpression()));
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}

function hasKey(node: Node, key: string): boolean {
  const value = unwrapExpression(node);
  return Node.isObjectLiteralExpression(value) && value.getProperties().some((p) => propertyKey(p) === key);
}

function isTrue(node: Node): boolean {
  return unwrapExpression(node).getKind() === SyntaxKind.TrueKeyword;
}

function isFalse(node: Node): boolean {
  return unwrapExpression(node).getKind() === SyntaxKind.FalseKeyword;
}

/** A value that can't hold arguments: a string, number, boolean, null, date, ... */
function isPlainValue(node: Node): boolean {
  const value = unwrapExpression(node);
  if (Node.isObjectLiteralExpression(value) || Node.isArrayLiteralExpression(value)) return false;
  return isPlainType(value.getType());
}

function isPlainType(type: Type): boolean {
  if (type.isAny() || type.isUnknown()) return false;
  if (type.isUnion()) return type.getUnionTypes().every(isPlainType);
  if (type.isString() || type.isNumber() || type.isBoolean() || type.isBigInt() || type.isNull() || type.isUndefined()) return true;
  if (type.isLiteral() || type.isBooleanLiteral() || type.isEnum() || type.isEnumLiteral() || type.isTemplateLiteral()) return true;
  const name = type.getSymbol()?.getName();
  return name === "Date" || name === "Decimal" || name === "Buffer" || name === "Uint8Array";
}

/**
 * Whether a value of this type could name a relation, at any depth of nested
 * arguments. `any` and `unknown` could; without the relations, any object could.
 */
function mayNameRelation(type: Type, relations: Map<string, Relation> | undefined, at: Node, seen = new Set<object>()): boolean {
  if (type.isAny() || type.isUnknown()) return true;
  if (isPlainType(type) || seen.has(type.compilerType)) return false;
  if (!relations) return true;
  seen.add(type.compilerType);
  // A generic type (`T extends Prisma.LeadFindManyArgs`, `Prisma.SelectSubset<T, ...>`)
  // is checked by its constraint; one whose keys aren't known yet could hold any.
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    return constraint === undefined || mayNameRelation(constraint, relations, at, seen);
  }
  if (type.getFlags() & (ts.TypeFlags.Conditional | ts.TypeFlags.Substitution | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess)) return true;
  const parts = type.isUnion() ? type.getUnionTypes() : type.isIntersection() ? type.getIntersectionTypes() : undefined;
  if (parts) return parts.some((t) => mayNameRelation(t, relations, at, seen));
  if (type.isArray()) return mayNameRelation(type.getArrayElementTypeOrThrow(), relations, at, seen);
  return type.getProperties().some((p) => {
    const name = p.getName();
    return relations.has(name) || (STRUCTURAL.has(name) && mayNameRelation(p.getTypeAtLocation(at), relations, at, seen));
  });
}

// --- relations, from the generated client ----------------------------------------

const relationCache = new WeakMap<object, Map<string, Relation>>();

/** A model's relations, or undefined when its payload type isn't known. */
function relationsOf(model: Model, at: Node): Map<string, Relation> | undefined {
  const payload = model.payload;
  if (!payload) return undefined;
  const cached = relationCache.get(payload.compilerType);
  if (cached) return cached;
  const objects = payload.getProperty("objects");
  if (!objects) return undefined;
  // `<Model>UncheckedCreateInput`, declared next to the payload, sets foreign keys
  // directly, so it lists every relation except those whose key is kept in this model.
  const unchecked = aliasesIn(objects.getDeclarations()[0]!.getSourceFile()).get(`${literalName(payload, at)}UncheckedCreateInput`);
  const direct = new Set(unchecked?.getType().getProperties().map((p) => p.getName()));
  const relations = new Map<string, Relation>();
  for (const p of objects.getTypeAtLocation(at).getProperties()) {
    let type = p.getTypeAtLocation(at).getNonNullableType();
    const many = type.isArray();
    if (many) type = type.getArrayElementTypeOrThrow();
    const known = literalName(type, at);
    relations.set(p.getName(), {
      model: known === undefined ? { table: undefined, payload: undefined } : { table: accessor(known), payload: type },
      many,
      keyThere: !unchecked || direct.has(p.getName()),
    });
  }
  relationCache.set(payload.compilerType, relations);
  return relations;
}

/** A payload's model name, when its `name` is a literal: `"Lead"`. */
function literalName(payload: Type, at: Node): string | undefined {
  const name = payload.getProperty("name")?.getTypeAtLocation(at);
  return name?.isStringLiteral() ? String(name.getLiteralValue()) : undefined;
}

type Alias = Node & { getType(): Type };
const aliasCache = new WeakMap<SourceFile, Map<string, Alias>>();

/** The type aliases in a generated client file, by name: $LeadPayload, LeadUncheckedCreateInput, ... */
function aliasesIn(sourceFile: SourceFile): Map<string, Alias> {
  let aliases = aliasCache.get(sourceFile);
  if (!aliases) {
    aliases = new Map();
    for (const alias of sourceFile.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) aliases.set(alias.getName(), alias);
    aliasCache.set(sourceFile, aliases);
  }
  return aliases;
}
