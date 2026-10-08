// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Drizzle ORM. The table in db.read/db.write is the name given to pgTable,
// mysqlTable, or sqliteTable: `pgTable("audit_log", ...)` is `audit_log`, whatever
// the variable is called.
//
//   db.select().from(t), .leftJoin(t, ...)      db.read(t)
//   db.insert(t), db.update(t), db.delete(t)    db.write(t)
//   db.query.<key>.findMany / findFirst          db.read(<key>), plus each `with` relation
//   db.execute / run / all / get / values(sql)   raw SQL: bare db.read and db.write
//   sql`...` and sql.raw("...") in a query       the tables its SQL names (see fragment)
//   new StringChunk("..."), new SQL([...])        the same, from drizzle's own pieces
//   a column's $defaultFn / $onUpdateFn           the SQL they return, in inserts and updates

import { Node, SyntaxKind, VariableDeclarationKind, type CallExpression, type SourceFile, type Symbol as MorphSymbol, type TemplateLiteral, type Type } from "ts-morph";
import { packageName, packageOf } from "../adapters.js";
import type { Capability } from "../capability.js";
import { descendantsOfKind } from "../walk.js";
import { sqlTables } from "./sql-tables.js";
import { argumentsOf, containerName, literalString, resolveAlias, resolvedDeclaration, unwrapExpression, type CallLike, type CapabilityUse } from "./shared.js";

const WRITES = new Set(["insert", "update", "delete"]);
const RAW = new Set(["execute", "run", "all", "get", "values"]);
const JOIN = /^(from|(left|right|inner|full|cross)Join(Lateral)?)$/;

export function drizzleCapabilities(declaration: Node, call: CallLike | undefined): Capability[] {
  if (!inDrizzle(declaration)) return [];
  const sql = fragment(declaration, call);
  if (sql) return sql;
  // A value with a getSQL() method of the project's own is pasted into the query as
  // whatever SQL it returns: `.where(wrapper)`, a select field, a value to set.
  if (call && argumentsOf(call).some((a) => pastesOwnSql(a))) return unknownSql;
  // Real drizzle declares joins as function-typed properties (`leftJoin: PgSelectJoinFn`),
  // whose signatures have no name; the call site names them.
  const method = memberName(declaration) ?? calledName(call);
  if (!method) return [];
  const container = containerName(declaration) ?? "";
  const args = call ? argumentsOf(call) : [];
  const isDatabase = /Database$/.test(container);

  if (isDatabase && WRITES.has(method)) {
    const defaults = method === "insert" ? INSERT_DEFAULTS : method === "update" ? UPDATE_DEFAULTS : undefined;
    return [{ name: "db.write", ...table(args[0]) }, ...(defaults ? runtimeDefaults(args[0], defaults) : [])];
  }
  if (isDatabase && RAW.has(method)) return [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];
  if (isDatabase && method === "$count") return [{ name: "db.read", ...table(args[0]) }];
  if (JOIN.test(method)) return [{ name: "db.read", ...table(args[0]) }];
  if (container === "RelationalQueryBuilder" && (method === "findMany" || method === "findFirst")) {
    const key = relationalKey(call);
    return [key === undefined ? { name: "db.read", dynamic: true } : { name: "db.read", arg: key }, ...relationReads(args[0])];
  }
  // Migrations run arbitrary DDL and DML from files.
  if (method === "migrate") return [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];
  return [];
}

/** Whether a declaration is drizzle-orm's own. */
function inDrizzle(declaration: Node): boolean {
  const pkg = packageOf(declaration);
  return pkg !== undefined && packageName(pkg) === "drizzle-orm";
}

const TABLE_FUNCTIONS = new Set(["pgTable", "mysqlTable", "sqliteTable", "singlestoreTable", "gelTable"]);

/**
 * A table argument's name, from its definition: pgTable("name", ...),
 * pgSchema("schema").table("name", ...), or alias(table, ...). Anything else,
 * including pgTableCreator prefixes and non-literal names, is dynamic: a guessed
 * name could be the wrong table.
 */
function table(arg: Node | undefined): { arg: string } | { dynamic: true } {
  const created = definitionCall(arg);
  if (!created) return { dynamic: true };
  const callee = unwrapExpression(created.getExpression());
  const [first] = created.getArguments();
  // pgTable("leads", ...)
  if (Node.isIdentifier(callee) && TABLE_FUNCTIONS.has(callee.getText()) && fromDrizzle(callee)) {
    const name = literalString(first);
    return name === undefined ? { dynamic: true } : { arg: name };
  }
  if (Node.isPropertyAccessExpression(callee)) {
    // pgSchema("private").table("secrets", ...)
    const owner = unwrapExpression(callee.getExpression());
    if (callee.getName() === "table" && Node.isCallExpression(owner) && /Schema$/.test(owner.getExpression().getText()) && fromDrizzle(callee.getNameNode())) {
      const schema = literalString(owner.getArguments()[0]);
      const name = literalString(first);
      return schema === undefined || name === undefined ? { dynamic: true } : { arg: `${schema}.${name}` };
    }
  }
  return { dynamic: true };
}

/**
 * The call a table argument was made by, written in place or held in a `const`; for
 * `alias(leads, "l")`, the one that made leads.
 */
function definitionCall(arg: Node | undefined, depth = 0): CallExpression | undefined {
  if (!arg || depth > 5) return undefined;
  const created = constValue(unwrapExpression(arg));
  if (!created || !Node.isCallExpression(created)) return undefined;
  const callee = unwrapExpression(created.getExpression());
  const [first, second] = created.getArguments();
  if (Node.isIdentifier(callee) && callee.getText() === "alias" && fromDrizzle(callee) && second !== undefined) {
    return definitionCall(first, depth + 1);
  }
  return created;
}

/** An expression, or the initializer of the `const` a name or `ns.name` refers to. */
function constValue(node: Node): Node | undefined {
  if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) return node;
  const symbol = (Node.isPropertyAccessExpression(node) ? node.getNameNode() : node).getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
  if (declaration.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
  const init = declaration.getInitializer();
  return init && unwrapExpression(init);
}

// A column's functions that drizzle calls as it builds a statement, putting what they
// return into it: the default ones on insert, the update ones on update (and on insert,
// for a column with no default).
const INSERT_DEFAULTS = new Set(["$defaultFn", "$default", "$onUpdateFn", "$onUpdate"]);
const UPDATE_DEFAULTS = new Set(["$onUpdateFn", "$onUpdate"]);

/**
 * The SQL a table's runtime defaults put into an insert or update, read from the table's
 * definition: its columns written in place, in a `const`, or spread in from a `const` or
 * from what a function of the project's returns. A table PermLang can't find, or columns
 * it can't see, could put SQL that reads any table into the statement.
 */
function runtimeDefaults(arg: Node | undefined, names: ReadonlySet<string | undefined>): Capability[] {
  // A table drizzle made (pgTable(...), a schema's or a table creator's), whatever its name.
  const definition = definitionCall(arg);
  const made = definition && resolvedDeclaration(definition);
  const sources = made && inDrizzle(made) ? columnSources(definition) : undefined;
  if (!sources) return [{ name: "db.read", dynamic: true }];
  return sources.flatMap((source) =>
    source.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
      const declaration = resolvedDeclaration(call);
      return declaration && inDrizzle(declaration) && names.has(memberName(declaration)) ? returnedSql(call.getArguments()[0]) : [];
    }),
  );
}

/**
 * The code that defines a table's columns: its definition, its columns argument when that's
 * a `const`, and each object spread into them. Undefined when some of it can't be found.
 */
function columnSources(definition: CallExpression): Node[] | undefined {
  const sources: Node[] = [definition];
  const add = (expression: Node): boolean => {
    const found = objectsOf(unwrapExpression(expression));
    if (!found) return false;
    for (const f of found) if (!sources.includes(f)) sources.push(f);
    return true;
  };
  const columns = definition.getArguments()[1];
  const inner = columns && unwrapExpression(columns);
  if (inner && !Node.isObjectLiteralExpression(inner) && !Node.isArrowFunction(inner) && !Node.isFunctionExpression(inner) && !add(inner)) return undefined;
  for (let i = 0; i < sources.length; i++) {
    if (sources.length > 16) return undefined;
    for (const spread of sources[i]!.getDescendantsOfKind(SyntaxKind.SpreadAssignment)) {
      if (!add(spread.getExpression())) return undefined;
    }
  }
  return sources;
}

/** The object literals an expression stands for: one held in a `const`, or those a project function returns. */
function objectsOf(expression: Node): Node[] | undefined {
  const value = constValue(expression);
  if (value && Node.isObjectLiteralExpression(value)) return [value];
  if (!value || !Node.isCallExpression(value)) return undefined;
  const fn = resolvedDeclaration(value);
  if (!fn || !(Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) || packageOf(fn) !== undefined) return undefined;
  const body = fn.getBody();
  if (!body) return undefined;
  const returned = Node.isBlock(body) ? ownReturns(body, fn) : [body];
  const objects = returned.map((r) => r && unwrapExpression(r));
  return objects.every((o) => o && Node.isObjectLiteralExpression(o)) ? (objects as Node[]) : undefined;
}

/** The values a function's own return statements give, not those of functions inside it. */
function ownReturns(body: Node, fn: Node): (Node | undefined)[] {
  return body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => r.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) || Node.isMethodDeclaration(a)) === fn)
    .map((r) => r.getExpression());
}

/** The SQL a runtime default function returns: a fragment's tables, or unknown SQL for anything else that could be SQL. */
function returnedSql(fn: Node | undefined): Capability[] {
  if (!fn) return [];
  const f = unwrapExpression(fn);
  if (!Node.isArrowFunction(f) && !Node.isFunctionExpression(f)) {
    // A function defined elsewhere: what it returns can't be read here.
    return f.getType().getCallSignatures().some((s) => couldBeSql(s.getReturnType())) ? unknownSql : [];
  }
  const body = f.getBody();
  const returned = Node.isBlock(body) ? ownReturns(body, f) : [body];
  return returned.flatMap((value) => {
    if (!value) return [];
    const inner = unwrapExpression(value);
    if (Node.isTaggedTemplateExpression(inner) || Node.isCallExpression(inner)) {
      const declaration = resolvedDeclaration(inner);
      const read = declaration && inDrizzle(declaration) ? sqlPiece(declaration, inner) : undefined;
      if (read) return read;
    }
    return couldBeSql(inner.getType()) ? unknownSql : [];
  });
}

/** A type a value of which could be SQL: `SQL`, another object with getSQL(), `any`, or `unknown`. */
function couldBeSql(type: Type): boolean {
  if (type.isAny() || type.isUnknown()) return true;
  return (type.isUnion() ? type.getUnionTypes() : [type]).some((t) => t.getProperty("getSQL") !== undefined);
}

/**
 * A value whose getSQL() method is the project's own, at any depth of the array and
 * object literals it's written in: drizzle pastes in whatever SQL that returns.
 */
function pastesOwnSql(value: Node, depth = 0): boolean {
  if (depth > 8) return false;
  const inner = unwrapExpression(value);
  if (Node.isArrayLiteralExpression(inner)) return inner.getElements().some((e) => pastesOwnSql(e, depth + 1));
  if (ownsGetSql(inner.getType())) return true;
  return Node.isObjectLiteralExpression(inner) && inner.getProperties().some((p) => Node.isPropertyAssignment(p) && pastesOwnSql(p.getInitializerOrThrow(), depth + 1));
}

function ownsGetSql(type: Type): boolean {
  return (type.isUnion() ? type.getUnionTypes() : [type]).some((t) => t.getProperty("getSQL")?.getDeclarations().some((d) => packageOf(d) === undefined) === true);
}

/** A declaration's name: a method's, or a function-typed property's (`$default: (fn) => ...`). */
function memberName(declaration: Node): string | undefined {
  if (Node.isFunctionTypeNode(declaration)) {
    const holder = declaration.getParent();
    return Node.isPropertyDeclaration(holder) || Node.isPropertySignature(holder) ? holder.getName() : undefined;
  }
  return "getName" in declaration ? (declaration as { getName(): string | undefined }).getName() : undefined;
}

/** Whether a name resolves into drizzle-orm itself. */
function fromDrizzle(name: Node): boolean {
  const symbol = name.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  const pkg = declaration && packageOf(declaration);
  return pkg !== undefined && packageName(pkg) === "drizzle-orm";
}

function calledName(call: CallLike | undefined): string | undefined {
  if (!call || Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
}

/** `leads` in `db.query.leads.findMany()`: the schema key. */
function relationalKey(call: CallLike | undefined): string | undefined {
  if (!call || Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const holder = unwrapExpression(callee.getExpression());
  if (Node.isPropertyAccessExpression(holder)) return holder.getName();
  if (Node.isElementAccessExpression(holder)) return literalString(holder.getArgumentExpression());
  return undefined;
}

/**
 * Relations loaded with { with: { posts: { with: { comments: true } } } }, which are
 * read too, at any depth. Options that aren't written out (a variable, a spread)
 * could load any relation, so they read an unknown table.
 */
function relationReads(config: Node | undefined, depth = 0): Capability[] {
  if (!config) return [];
  if (depth > 64) return [{ name: "db.read", dynamic: true }];
  const object = unwrapExpression(config);
  if (!Node.isObjectLiteralExpression(object)) return [{ name: "db.read", dynamic: true }];
  if (object.getProperties().some((p) => Node.isSpreadAssignment(p))) return [{ name: "db.read", dynamic: true }];
  const withProp = object.getProperty("with");
  if (!withProp) return [];
  if (!Node.isPropertyAssignment(withProp)) return [{ name: "db.read", dynamic: true }];
  const value = withProp.getInitializer() && unwrapExpression(withProp.getInitializer()!);
  if (!value || !Node.isObjectLiteralExpression(value)) return [{ name: "db.read", dynamic: true }];
  const out: Capability[] = [];
  for (const p of value.getProperties()) {
    const key = relationKey(p);
    if (key === undefined) {
      out.push({ name: "db.read", dynamic: true });
      continue;
    }
    out.push({ name: "db.read", arg: key });
    const nested = Node.isPropertyAssignment(p) ? p.getInitializer() : undefined;
    const nestedValue = nested && unwrapExpression(nested);
    if (nestedValue && Node.isObjectLiteralExpression(nestedValue)) out.push(...relationReads(nestedValue, depth + 1));
    else if (nestedValue && !(Node.isTrueLiteral(nestedValue) || Node.isFalseLiteral(nestedValue))) out.push({ name: "db.read", dynamic: true });
  }
  return out;
}

/** A `with` key as written: `posts`, `"posts"`, or `["posts"]`; undefined when computed or a method. */
function relationKey(p: Node): string | undefined {
  if (Node.isShorthandPropertyAssignment(p)) return p.getName();
  if (!Node.isPropertyAssignment(p)) return undefined;
  const name = p.getNameNode();
  if (Node.isComputedPropertyName(name)) return literalString(unwrapExpression(name.getExpression()));
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}

// --- sql fragments ----------------------------------------------------------------

const unknownSql: Capability[] = [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];

// SQL that a schema definition holds for the database's own use: column defaults and
// generated columns, check constraints, partial-index conditions, views, and row-level
// security policies. Migrations put it into the database (and are checked as raw SQL);
// no query here runs it. A view is read as an unknown table. Read back out of the schema
// object (`check(...).value`), it could go into a query, so such reads are unknown SQL
// (schemaSqlReads). What a column's $defaultFn and $onUpdateFn return doesn't run where
// it's written either: drizzle puts it into inserts and updates, which are charged with
// it (runtimeDefaults).
const SCHEMA_CONTAINER = /(ColumnBuilder|IndexBuilder|ViewBuilder|ViewBuilderCore)$/;
const SCHEMA_FUNCTIONS = new Set(["check", "pgPolicy"]);

/**
 * A `sql` fragment in a query, `.where(sql`EXISTS (SELECT 1 FROM secrets)`)`, or the
 * text `sql.raw()` or `new StringChunk()` pastes in. Its tables are read from its SQL as
 * raw SQL's are, where it is written; anything the reader can't follow needs bare
 * db.read and db.write. Undefined for anything else in drizzle-orm.
 */
function fragment(declaration: Node, call: CallLike | undefined): Capability[] | undefined {
  const read = sqlPiece(declaration, call);
  // A schema definition's own sql`...` isn't run by a query here.
  return read && call && Node.isTaggedTemplateExpression(call) && inSchemaDefinition(call) ? [] : read;
}

/** What a piece of drizzle SQL pastes in, wherever it's written; undefined for anything else in drizzle-orm. */
function sqlPiece(declaration: Node, call: CallLike | undefined): Capability[] | undefined {
  if (Node.isConstructorDeclaration(declaration)) return piece(containerName(declaration), call);
  if (!Node.isFunctionDeclaration(declaration)) return undefined;
  const name = declaration.getName();
  const holder = containerName(declaration);
  if (name === "raw" && holder === "sql") return fromFragment(call ? literalString(argumentsOf(call)[0]) : undefined);
  // SQL put together from a list of pieces could hold any of them.
  if (name === "fromList" && holder === "sql") return unknownSql;
  if (name !== "sql" || holder !== undefined) return undefined;
  // Called as a function, with an array made to look like a template's strings.
  if (!call || !Node.isTaggedTemplateExpression(call)) return unknownSql;
  return fromFragment(fragmentText(call.getTemplate()));
}

/**
 * The pieces sql`...` is made of, built directly: `new StringChunk(text)` is pasted in as
 * it is, so literal text is read like sql.raw()'s, and `new SQL(chunks)` could hold any
 * pieces. Undefined for other classes.
 */
function piece(container: string | undefined, call: CallLike | undefined): Capability[] | undefined {
  if (container === "SQL") return unknownSql;
  if (container !== "StringChunk") return undefined;
  return fromFragment(call ? chunkText(argumentsOf(call)[0]) : undefined);
}

/** A StringChunk's text: a literal, or an array of literals, joined. */
function chunkText(arg: Node | undefined): string | undefined {
  const text = literalString(arg);
  if (text !== undefined || !arg) return text;
  const list = unwrapExpression(arg);
  if (!Node.isArrayLiteralExpression(list)) return undefined;
  const parts = list.getElements().map((e) => literalString(unwrapExpression(e)));
  return parts.every((p) => p !== undefined) ? parts.join("") : undefined;
}

/**
 * The fragment's text with each substitution in place: a table's name, quoted, or
 * otherwise `$n`, since drizzle binds values and columns can't name a table. A
 * nested fragment or `sql.raw()` is read where it's written, so as `$n` here it can
 * only make this one unknown (`FROM $1`), never hide a table. Undefined when a
 * substitution has a getSQL() method of the project's own, whose SQL is pasted in.
 */
function fragmentText(template: TemplateLiteral): string | undefined {
  if (Node.isNoSubstitutionTemplateLiteral(template)) return template.getLiteralValue();
  if (template.getTemplateSpans().some((span) => pastesOwnSql(span.getExpression()))) return undefined;
  const parts = [template.getHead().getLiteralText()];
  template.getTemplateSpans().forEach((span, i) => {
    const named = table(span.getExpression());
    const text = "arg" in named ? named.arg.split(".").map((p) => `"${p.replaceAll('"', '""')}"`).join(".") : `$${i + 1}`;
    parts.push(text, span.getLiteral().getLiteralText());
  });
  return parts.join("");
}

const STATEMENT_START = /^(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|VALUES|TABLE)\b/i;

/**
 * Whether a fragment is a whole statement, after any comments; anything else stands for an
 * expression. A loop rather than one regular expression, whose repeated comment group could
 * backtrack exponentially on text built for it: this reads code from pull requests.
 */
export function isStatement(text: string): boolean {
  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      if (end === -1) return false;
      i = end + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      return STATEMENT_START.test(text.slice(i));
    }
  }
}

function fromFragment(text: string | undefined): Capability[] {
  if (text === undefined) return unknownSql;
  // An expression is read as a select list, so a subquery or FROM in it still counts.
  const tables = sqlTables(isStatement(text) ? text : `SELECT ${text}`);
  if (!tables) return unknownSql;
  return [
    ...tables.read.map((t): Capability => ({ name: "db.read", arg: t })),
    ...tables.write.map((t): Capability => ({ name: "db.write", arg: t })),
  ];
}

/** Whether a fragment is passed to a schema definition: `.default(sql`now()`)`, `check(...)`, ... */
function inSchemaDefinition(node: Node): boolean {
  // Look through what can carry a fragment into a call: (...), `as`, arrays, objects, and a
  // function that returns it, from an arrow's body or a `return` in its block.
  let child = node;
  let parent = node.getParentOrThrow();
  for (;;) {
    const fn = Node.isReturnStatement(parent) ? returningFunction(parent) : undefined;
    if (fn) [child, parent] = [fn, fn.getParentOrThrow()];
    else if (carries(parent, child)) [child, parent] = [parent, parent.getParentOrThrow()];
    else break;
  }
  if (!Node.isCallExpression(parent) || !parent.getArguments().includes(child)) return false;
  const declaration = resolvedDeclaration(parent);
  if (declaration === undefined || packageOf(declaration) !== "drizzle-orm") return false;
  const name = Node.isFunctionDeclaration(declaration) ? declaration.getName() : undefined;
  return SCHEMA_CONTAINER.test(containerName(declaration) ?? "") || SCHEMA_FUNCTIONS.has(String(name));
}

// Properties of drizzle's schema objects that hold the SQL a definition was given: a
// column's default (and its runtime functions), a check's value, a policy's conditions,
// an index's condition and columns, a generated column's expression, a view's query.
const SCHEMA_SQL = new Set(["default", "defaultFn", "onUpdateFn", "value", "using", "withCheck", "where", "columns", "as", "query"]);

/**
 * SQL read back out of a drizzle object, `check(...).value` or `leads.score.default`: a
 * schema definition's SQL isn't read where it's written, so read back, it could go into
 * a query unread. Each read of a drizzle property that holds SQL (or a function that
 * returns it) is unknown SQL: by name (`x.value`, `x["value"]`) or destructured.
 */
export function schemaSqlReads(sourceFile: SourceFile): { node: Node; uses: CapabilityUse[] }[] {
  const reads: { node: Node; uses: CapabilityUse[] }[] = [];
  const check = (node: Node, object: Node, name: string | undefined) => {
    if (name === undefined || !SCHEMA_SQL.has(name)) return;
    const property = object.getType().getProperty(name);
    if (!property || !holdsSchemaSql(property, node)) return;
    const text = node.getText().replace(/\s+/g, " ");
    reads.push({ node, uses: unknownSql.map((capability) => ({ capability, call: text.length > 70 ? `${text.slice(0, 67)}...` : text, verb: "reads" })) });
  };
  for (const access of descendantsOfKind(sourceFile, SyntaxKind.PropertyAccessExpression)) {
    if (!isAssigned(access)) check(access, access.getExpression(), access.getName());
  }
  for (const access of descendantsOfKind(sourceFile, SyntaxKind.ElementAccessExpression)) {
    if (!isAssigned(access)) check(access, access.getExpression(), literalString(access.getArgumentExpression()));
  }
  for (const binding of descendantsOfKind(sourceFile, SyntaxKind.BindingElement)) {
    const pattern = binding.getParentOrThrow();
    if (!Node.isObjectBindingPattern(pattern)) continue;
    const key = binding.getPropertyNameNode();
    check(binding, pattern, key ? (Node.isIdentifier(key) ? key.getText() : literalString(key)) : binding.getName());
  }
  return reads;
}

/** A drizzle property, not a method, whose type holds SQL: `SQL`, a union with it, or a function returning it. */
function holdsSchemaSql(property: MorphSymbol, at: Node): boolean {
  const declarations = property.getDeclarations();
  if (!declarations.some((d) => (Node.isPropertyDeclaration(d) || Node.isPropertySignature(d)) && inDrizzle(d))) return false;
  return mentionsSql(property.getTypeAtLocation(at));
}

function mentionsSql(type: Type, depth = 0): boolean {
  if (depth > 4) return false;
  if (type.isUnion()) return type.getUnionTypes().some((t) => mentionsSql(t, depth + 1));
  if (type.isArray()) return mentionsSql(type.getArrayElementTypeOrThrow(), depth + 1);
  if (type.getCallSignatures().some((s) => mentionsSql(s.getReturnType(), depth + 1))) return true;
  const symbol = type.getSymbol();
  return symbol?.getName() === "SQL" && symbol.getDeclarations().some(inDrizzle);
}

/** The target of an assignment, which writes the property rather than reading it. */
function isAssigned(access: Node): boolean {
  const parent = access.getParent();
  return Node.isBinaryExpression(parent) && parent.getLeft() === access && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}

/** The arrow function or function expression a `return` returns from; undefined for a named function or a method. */
function returningFunction(statement: Node): Node | undefined {
  const fn = statement.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) || Node.isMethodDeclaration(a));
  return Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) ? fn : undefined;
}

function carries(parent: Node, child: Node): boolean {
  return (
    Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent) ||
    Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) || Node.isPropertyAssignment(parent) ||
    (Node.isArrowFunction(parent) && parent.getBody() === child)
  );
}
