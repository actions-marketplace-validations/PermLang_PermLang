// Drizzle ORM. The table in db.read/db.write is the name given to pgTable,
// mysqlTable, or sqliteTable: `pgTable("audit_log", ...)` is `audit_log`, whatever
// the variable is called.
//
//   db.select().from(t), .leftJoin(t, ...)      db.read(t)
//   db.insert(t), db.update(t), db.delete(t)    db.write(t)
//   db.query.<key>.findMany / findFirst          db.read(<key>), plus each `with` relation
//   db.execute / run / all / get / values(sql)   raw SQL: bare db.read and db.write
//   sql`...` and sql.raw("...") in a query       the tables its SQL names (see fragment)

import { Node, type TemplateLiteral } from "ts-morph";
import { packageName, packageOf } from "../adapters.js";
import type { Capability } from "../capability.js";
import { sqlTables } from "./sql-tables.js";
import { argumentsOf, containerName, literalString, resolveAlias, resolvedDeclaration, unwrapExpression, type CallLike } from "./shared.js";

const WRITES = new Set(["insert", "update", "delete"]);
const RAW = new Set(["execute", "run", "all", "get", "values"]);
const JOIN = /^(from|(left|right|inner|full|cross)Join(Lateral)?)$/;

export function drizzleCapabilities(declaration: Node, call: CallLike | undefined): Capability[] {
  const pkg = packageOf(declaration);
  if (pkg === undefined || packageName(pkg) !== "drizzle-orm") return [];
  const sql = fragment(declaration, call);
  if (sql) return sql;
  // Real drizzle declares joins as function-typed properties (`leftJoin: PgSelectJoinFn`),
  // whose signatures have no name; the call site names them.
  const method = ("getName" in declaration ? (declaration as { getName(): string | undefined }).getName() : undefined) ?? calledName(call);
  if (!method) return [];
  const container = containerName(declaration) ?? "";
  const args = call ? argumentsOf(call) : [];
  const isDatabase = /Database$/.test(container);

  if (isDatabase && WRITES.has(method)) return [{ name: "db.write", ...table(args[0]) }];
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

const TABLE_FUNCTIONS = new Set(["pgTable", "mysqlTable", "sqliteTable", "singlestoreTable", "gelTable"]);

/**
 * A table argument's name, from its definition: pgTable("name", ...),
 * pgSchema("schema").table("name", ...), or alias(table, ...). Anything else,
 * including pgTableCreator prefixes and non-literal names, is dynamic: a guessed
 * name could be the wrong table.
 */
function table(arg: Node | undefined, depth = 0): { arg: string } | { dynamic: true } {
  if (!arg || depth > 5) return { dynamic: true };
  const node = unwrapExpression(arg);
  if (Node.isCallExpression(node)) return definition(node, depth);
  const nameNode = Node.isPropertyAccessExpression(node) ? node.getNameNode() : node;
  const symbol = nameNode.getSymbol();
  const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
  if (!declaration || !Node.isVariableDeclaration(declaration)) return { dynamic: true };
  if (declaration.getVariableStatement()?.getDeclarationKind() !== "const") return { dynamic: true };
  const init = declaration.getInitializer();
  const created = init && unwrapExpression(init);
  return created && Node.isCallExpression(created) ? definition(created, depth) : { dynamic: true };
}

function definition(created: Node & { getExpression(): Node; getArguments(): Node[] }, depth: number): { arg: string } | { dynamic: true } {
  const callee = unwrapExpression(created.getExpression());
  const [first, second] = created.getArguments();
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
  // alias(leads, "l") reads leads.
  if (Node.isIdentifier(callee) && callee.getText() === "alias" && fromDrizzle(callee) && second !== undefined) {
    return table(first, depth + 1);
  }
  return { dynamic: true };
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

// SQL that a schema definition holds: column defaults and generated columns, check
// constraints, partial-index conditions, views, and row-level security policies.
// It runs inside the database (on insert, or through migrations, which are checked
// as raw SQL), not as part of a query here. A view is read as an unknown table.
const SCHEMA_CONTAINER = /(ColumnBuilder|IndexBuilder|ViewBuilder|ViewBuilderCore)$/;
const SCHEMA_FUNCTIONS = new Set(["check", "pgPolicy"]);

/**
 * A `sql` fragment in a query, `.where(sql`EXISTS (SELECT 1 FROM secrets)`)`, or the
 * text `sql.raw()` pastes in. Its tables are read from its SQL as raw SQL's are,
 * where it is written; anything the reader can't follow needs bare db.read and
 * db.write. Undefined for anything else in drizzle-orm.
 */
function fragment(declaration: Node, call: CallLike | undefined): Capability[] | undefined {
  if (!Node.isFunctionDeclaration(declaration)) return undefined;
  const name = declaration.getName();
  const holder = containerName(declaration);
  if (name === "raw" && holder === "sql") return fromFragment(call ? literalString(argumentsOf(call)[0]) : undefined);
  if (name !== "sql" || holder !== undefined) return undefined;
  // Called as a function, with an array made to look like a template's strings.
  if (!call || !Node.isTaggedTemplateExpression(call)) return unknownSql;
  return inSchemaDefinition(call) ? [] : fromFragment(fragmentText(call.getTemplate()));
}

/**
 * The fragment's text with each substitution in place: a table's name, quoted, or
 * otherwise `$n`, since drizzle binds values and columns can't name a table. A
 * nested fragment or `sql.raw()` is read where it's written, so as `$n` here it can
 * only make this one unknown (`FROM $1`), never hide a table.
 */
function fragmentText(template: TemplateLiteral): string {
  if (Node.isNoSubstitutionTemplateLiteral(template)) return template.getLiteralValue();
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
  // Look through what can carry a fragment into a call: (...), `as`, arrays, objects, arrow functions.
  let child = node;
  let parent = node.getParentOrThrow();
  while (carries(parent, child)) {
    child = parent;
    parent = parent.getParentOrThrow();
  }
  if (!Node.isCallExpression(parent) || !parent.getArguments().includes(child)) return false;
  const declaration = resolvedDeclaration(parent);
  if (declaration === undefined || packageOf(declaration) !== "drizzle-orm") return false;
  const name = Node.isFunctionDeclaration(declaration) ? declaration.getName() : undefined;
  return SCHEMA_CONTAINER.test(containerName(declaration) ?? "") || SCHEMA_FUNCTIONS.has(String(name));
}

function carries(parent: Node, child: Node): boolean {
  return (
    Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent) ||
    Node.isArrayLiteralExpression(parent) || Node.isObjectLiteralExpression(parent) || Node.isPropertyAssignment(parent) ||
    (Node.isArrowFunction(parent) && parent.getBody() === child)
  );
}
