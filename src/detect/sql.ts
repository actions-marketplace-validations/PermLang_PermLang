// Raw-SQL database clients: pg, mysql2, better-sqlite3, sqlite3, postgres (postgres.js),
// @neondatabase/serverless, @vercel/postgres. When the query is literal text, its
// tables are read out of it (`SELECT ... FROM leads` → db.read(leads)). SQL built
// from strings can touch any table, and needs bare db.read and db.write.
//
// Tagged templates (postgres.js's sql`...`) bind their substitutions as parameters,
// so the literal parts still name the tables. A template string passed to query()
// is concatenation, which is how SQL injection happens: it is unknown.

import { Node, type PropertyAssignment, type ShorthandPropertyAssignment, type Type } from "ts-morph";
import { packageName, packageOf } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { sqlTables } from "./sql-tables.js";
import { argumentsOf, containerName, literalString, resolvedDeclaration, unwrapExpression, type CallLike } from "./shared.js";

/** Methods whose first argument is SQL text, per package. */
const TEXT_METHODS: Record<string, readonly string[]> = {
  pg: ["query"],
  mysql2: ["query", "execute", "prepare"],
  "better-sqlite3": ["prepare", "exec"],
  sqlite3: ["run", "all", "get", "each", "exec", "prepare"],
  postgres: ["unsafe"],
  "@neondatabase/serverless": ["query"],
  "@vercel/postgres": ["query"],
};

// Methods that touch no table: connection lifecycle, transactions (whose queries are
// checked where they're written), statement handles, and pure helpers. Every other
// method on these packages is unknown database access, so new or unusual APIs
// (COPY streams, pragmas, large objects) never pass silently. postgres.js's query
// modifiers (`.values()`, `.cursor()`, ...) run the query its tag already named.
const SAFE_METHODS: Record<string, readonly string[]> = {
  pg: ["connect", "end", "release", "on", "once", "off", "removeListener", "removeAllListeners", "pauseDrain", "resumeDrain", "getTransactionStatus", "escapeLiteral", "escapeIdentifier"],
  mysql2: ["createConnection", "createPool", "createPoolCluster", "connect", "end", "destroy", "release", "releaseConnection", "getConnection", "beginTransaction", "commit", "rollback", "ping", "pause", "resume", "escape", "escapeId", "format", "on", "once", "unprepare", "close", "reset", "promise"],
  "better-sqlite3": ["close", "transaction", "defaultSafeIntegers", "function", "aggregate", "table", "run", "get", "all", "iterate", "pluck", "expand", "raw", "columns", "bind", "safeIntegers"],
  sqlite3: ["verbose", "close", "serialize", "parallelize", "configure", "interrupt", "on", "once", "bind", "reset", "finalize"],
  postgres: [
    "postgres", "begin", "end", "reserve", "release", "json", "array", "typed", "savepoint",
    "values", "raw", "describe", "simple", "execute", "cancel", "cursor", "forEach", "stream", "readable", "writable",
  ],
  "@neondatabase/serverless": ["neon", "neonConfig", "transaction", "connect", "end", "release", "on"],
  "@vercel/postgres": ["createPool", "createClient", "connect", "end", "release", "on"],
};

// Methods that do more than query a table.
const SPECIAL_METHODS: Record<string, Record<string, readonly Capability[]>> = {
  "better-sqlite3": {
    loadExtension: [{ name: UNVERIFIABLE }],
    backup: [{ name: "fs.write", dynamic: true }, { name: "db.read", dynamic: true }],
    serialize: [{ name: "db.read", dynamic: true }],
  },
  sqlite3: { loadExtension: [{ name: UNVERIFIABLE }] },
  postgres: { file: [{ name: "fs.read", dynamic: true }, { name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }] },
};

// sqlite3's Statement has run/all/get too, without SQL text; only Database's take SQL.
const TEXT_CONTAINERS: Record<string, string> = { sqlite3: "Database" };

/** Packages whose tagged templates run SQL with bound parameters. */
const TAG_PACKAGES = new Set(["postgres", "@neondatabase/serverless", "@vercel/postgres"]);
/** Packages whose tag also runs SQL text called as a function: neon's `sql("SELECT ...")` before 1.0. */
const TEXT_CALL_PACKAGES = new Set(["@neondatabase/serverless"]);

/** Packages covered here, so they aren't reported as having no adapter. */
export const SQL_PACKAGES: readonly string[] = [...Object.keys(TEXT_METHODS)];

const unknown: Capability[] = [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];

/** `declaration` is the resolved signature of `call`. */
export function sqlCapabilities(declaration: Node, call: CallLike | undefined): Capability[] {
  const pkg = packageOf(declaration);
  if (pkg === undefined) return [];
  const name = packageName(pkg);
  if (!(name in TEXT_METHODS)) return [];

  if (call && Node.isTaggedTemplateExpression(call) && TAG_PACKAGES.has(name)) {
    return fromSql(templateText(call.getTemplate()));
  }
  // A call signature: postgres.js's `sql(value)` helper, or a tag called as a function.
  // Passed along as a value (to a repository, say), it is checked where it's called.
  if (Node.isCallSignatureDeclaration(declaration) || Node.isFunctionTypeNode(declaration)) {
    return call ? directCall(declaration, argumentsOf(call)[0], TEXT_CALL_PACKAGES.has(name)) : [];
  }
  // A constructor, or a function from the package, touches no table unless listed below.
  const method = memberName(declaration);
  if (!method) return [];
  const special = SPECIAL_METHODS[name]?.[method];
  if (special) return [...special];
  const textContainer = TEXT_CONTAINERS[name];
  if (TEXT_METHODS[name]!.includes(method) && (!textContainer || containerName(declaration) === textContainer)) {
    // Used as a value (no call), the SQL is unknown.
    if (!call) return unknown;
    const args = argumentsOf(call);
    // mysql2 pastes a value's toSqlString() into the SQL as it is: mysql.raw(...) does this.
    if (name === "mysql2" && args.some((a) => carriesSql(a.getType(), a))) return unknown;
    return fromSql(queryText(args[0]));
  }
  if (SAFE_METHODS[name]?.includes(method) || (textContainer && containerName(declaration) !== textContainer && TEXT_METHODS[name]!.includes(method))) {
    return [];
  }
  return unknown;
}

/**
 * A tag called as an ordinary function. Neon's `sql("SELECT ...")` (before 1.0)
 * takes SQL text. An array built to look like a template's strings runs as a query
 * in all of them, so the template signature called directly, or a helper given a
 * value that could be such an array, is unknown. Other helper calls, such as
 * postgres.js's `sql("name")`, build values.
 */
function directCall(signature: Node & { getParameters(): Node[] }, first: Node | undefined, takesText: boolean): Capability[] {
  if (!first) return [];
  const parameter = signature.getParameters()[0]!.getType();
  if (takesText && parameter.isString()) return fromSql(queryText(first));
  if (parameter.getSymbol()?.getName() === "TemplateStringsArray") return unknown;
  const types = [first.getType(), unwrapExpression(first).getType()];
  return types.some((t) => t.isAny() || t.isUnknown() || t.getProperty("raw") !== undefined) ? unknown : [];
}

function fromSql(sql: string | undefined): Capability[] {
  const tables = sql === undefined ? undefined : sqlTables(sql);
  if (!tables) return unknown;
  return [
    ...tables.read.map((t): Capability => ({ name: "db.read", arg: t })),
    ...tables.write.map((t): Capability => ({ name: "db.write", arg: t })),
  ];
}

/**
 * The SQL of a query argument: literal text, or a `{ text }` / `{ sql }` config
 * object with literal text. A config object is read only when its keys are all
 * written out and it names the SQL once: a spread, a computed key, or a getter
 * could replace it.
 */
function queryText(arg: Node | undefined): string | undefined {
  if (!arg) return undefined;
  const inner = unwrapExpression(arg);
  const direct = literalString(inner);
  if (direct !== undefined) return direct;
  if (!Node.isObjectLiteralExpression(inner)) return undefined;
  const props = inner.getProperties();
  const written = props.filter(
    (p): p is PropertyAssignment | ShorthandPropertyAssignment => (Node.isPropertyAssignment(p) && !Node.isComputedPropertyName(p.getNameNode())) || Node.isShorthandPropertyAssignment(p),
  );
  if (written.length !== props.length) return undefined;
  const sql = written.filter((p) => ["text", "sql"].includes(keyOf(p)));
  return sql.length === 1 ? propertyText(sql[0]!) : undefined;
}

/** A property's name, without quotes. */
function keyOf(prop: PropertyAssignment | ShorthandPropertyAssignment): string {
  const name = prop.getNameNode();
  return Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText();
}

/** The text a property holds: `{ text: "..." }`, or `{ text }` naming a constant. */
function propertyText(prop: PropertyAssignment | ShorthandPropertyAssignment): string | undefined {
  if (Node.isPropertyAssignment(prop)) return literalString(prop.getInitializer());
  const declaration = prop.getValueSymbol()?.getValueDeclaration();
  return declaration && Node.isVariableDeclaration(declaration) ? literalString(declaration.getNameNode()) : undefined;
}

/**
 * Whether a mysql2 argument holds a value with a `toSqlString` method: itself, an
 * element of its arrays (bulk inserts nest them), a named placeholder's value, or
 * the `values` of a `{ sql, values }` options object. Read from the type, so a
 * value held in a variable counts too.
 */
function carriesSql(type: Type, at: Node, seen = new Set<object>()): boolean {
  if (seen.has(type.compilerType)) return false;
  seen.add(type.compilerType);
  if (type.getProperty("toSqlString")) return true;
  const parts =
    type.isUnion() ? type.getUnionTypes()
    : type.isArray() ? [type.getArrayElementTypeOrThrow()]
    : type.isTuple() ? type.getTupleElements()
    : type.isObject() && type.getCallSignatures().length === 0 ? type.getProperties().map((p) => p.getTypeAtLocation(at))
    : [];
  return parts.some((t) => carriesSql(t, at, seen));
}

/**
 * A tagged template's literal parts, with each substitution as a bound parameter.
 * Undefined when a substitution is SQL itself rather than a value: postgres.js
 * `${sql(name)}` (an identifier), a nested sql`...` fragment, or `${sql.unsafe(x)}`,
 * any of which can name a table or inject a statement.
 */
function templateText(template: Node): string | undefined {
  if (Node.isNoSubstitutionTemplateLiteral(template)) return template.getLiteralValue();
  if (!Node.isTemplateExpression(template)) return undefined;
  const spans = template.getTemplateSpans();
  if (spans.some((s) => isSqlFragment(s.getExpression()))) return undefined;
  return [template.getHead().getLiteralText(), ...spans.map((s, i) => `$${i + 1}${s.getLiteral().getLiteralText()}`)].join("");
}

/** An expression whose value comes from a SQL package: a fragment, identifier, or helper. */
function isSqlFragment(expression: Node): boolean {
  const inner = unwrapExpression(expression);
  if (Node.isCallExpression(inner) || Node.isTaggedTemplateExpression(inner)) {
    const declaration = resolvedDeclaration(inner);
    const pkg = declaration && packageOf(declaration);
    if (pkg && TAG_PACKAGES.has(packageName(pkg))) return true;
  }
  const type = inner.getType();
  return [type.getSymbol(), type.getAliasSymbol()].some((symbol) =>
    symbol?.getDeclarations().some((d) => {
      const pkg = packageOf(d);
      return pkg !== undefined && TAG_PACKAGES.has(packageName(pkg));
    }),
  );
}

function memberName(d: Node): string | undefined {
  return "getName" in d ? (d as { getName(): string | undefined }).getName() : undefined;
}
