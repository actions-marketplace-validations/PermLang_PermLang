// Raw-SQL database clients: pg, mysql2, better-sqlite3, sqlite3, postgres (postgres.js),
// @neondatabase/serverless, @vercel/postgres, and Node's own node:sqlite. When the query is literal text, its
// tables are read out of it (`SELECT ... FROM leads` → db.read(leads)). SQL built
// from strings can touch any table, and needs bare db.read and db.write.
//
// Tagged templates (postgres.js's sql`...`) bind their substitutions as parameters,
// so the literal parts still name the tables. A template string passed to query()
// is concatenation, which is how SQL injection happens: it is unknown.

import { Node, type PropertyAssignment, type ShorthandPropertyAssignment, type Type } from "ts-morph";
import { packageName, packageOf } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { sqlTables, type SqlOptions } from "./sql-tables.js";
import { argumentsOf, containerName, literalString, propertyValue, resolvedDeclaration, unwrapExpression, type CallLike } from "./shared.js";

/** Methods whose first argument is SQL text, per package. */
const TEXT_METHODS: Record<string, readonly string[]> = {
  pg: ["query"],
  mysql2: ["query", "execute", "prepare"],
  "better-sqlite3": ["prepare", "exec"],
  sqlite3: ["run", "all", "get", "each", "exec", "prepare"],
  postgres: ["unsafe"],
  "@neondatabase/serverless": ["query"],
  "@vercel/postgres": ["query"],
  "node:sqlite": ["exec", "prepare"],
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
  "node:sqlite": ["close", "open", "function", "aggregate", "setAuthorizer", "enableLoadExtension", "enableDefensive", "createTagStore", "createSession", "location", "clear", "[Symbol.dispose]"],
};

// Methods that do more than query a table.
const SPECIAL_METHODS: Record<string, Record<string, readonly Capability[]>> = {
  "better-sqlite3": {
    loadExtension: [{ name: UNVERIFIABLE }],
    backup: [{ name: "fs.write", dynamic: true }, { name: "db.read", dynamic: true }],
    serialize: [{ name: "db.read", dynamic: true }],
  },
  sqlite3: { loadExtension: [{ name: UNVERIFIABLE }] },
  "node:sqlite": {
    loadExtension: [{ name: UNVERIFIABLE }],
    backup: [{ name: "fs.write", dynamic: true }, { name: "db.read", dynamic: true }],
    serialize: [{ name: "db.read", dynamic: true }],
    // A database image or a changeset can hold any table.
    deserialize: [{ name: "db.write", dynamic: true }],
    applyChangeset: [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }],
    // A session's changes, read out of the tables it watches.
    changeset: [{ name: "db.read", dynamic: true }],
    patchset: [{ name: "db.read", dynamic: true }],
  },
  postgres: { file: [{ name: "fs.read", dynamic: true }, { name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }] },
};

// Statement handles, whose methods run the SQL they were prepared with. (sqlite3's Statement
// has run/all/get too, without SQL text; only its Database's take SQL.)
const STATEMENT_CONTAINERS: Record<string, readonly string[]> = {
  mysql2: ["PreparedStatementInfo", "PrepareStatementInfo"],
  sqlite3: ["Statement"],
  "node:sqlite": ["StatementSync"],
};
// Objects whose methods are tags: node:sqlite's tag store, `store.all` with a template.
const TAG_CONTAINERS: Record<string, { container: string; tags: readonly string[] }> = {
  "node:sqlite": { container: "SQLTagStore", tags: ["all", "get", "iterate", "run"] },
};

/** Packages whose tagged templates run SQL with bound parameters. */
const TAG_PACKAGES = new Set(["postgres", "@neondatabase/serverless", "@vercel/postgres"]);
/** Packages whose tag also runs SQL text called as a function: neon's `sql("SELECT ...")` before 1.0. */
const TEXT_CALL_PACKAGES = new Set(["@neondatabase/serverless"]);

/** Packages covered here, so they aren't reported as having no adapter. */
export const SQL_PACKAGES: readonly string[] = [...Object.keys(TEXT_METHODS)];

/**
 * Node's own SQLite client, typed by @types/node as `declare module "node:sqlite"`: not the
 * npm package called sqlite (a wrapper around sqlite3), which has no adapter.
 */
export function isNodeSqlite(declaration: Node): boolean {
  return packageOf(declaration) === "sqlite" && declaration.getSourceFile().getFilePath().includes("/node_modules/@types/node/");
}

const unknown: Capability[] = [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];

/** `declaration` is the resolved signature of `call`. */
export function sqlCapabilities(declaration: Node, call: CallLike | undefined): Capability[] {
  const pkg = packageOf(declaration);
  if (pkg === undefined) return [];
  const name = isNodeSqlite(declaration) ? "node:sqlite" : packageName(pkg);
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
  const container = containerName(declaration) ?? "";
  // A prepared statement runs the SQL prepare() was given; its values are bound.
  if (STATEMENT_CONTAINERS[name]?.includes(container)) return [];
  // A tag reads its template. Called with anything else (an array made to look like a
  // template's strings), or used as a value, it could run any SQL.
  const store = TAG_CONTAINERS[name];
  if (store?.container === container && store.tags.includes(method)) return call && Node.isTaggedTemplateExpression(call) ? fromSql(templateText(call.getTemplate())) : unknown;
  if (TEXT_METHODS[name]!.includes(method)) {
    // Used as a value (no call), the SQL is unknown.
    if (!call) return unknown;
    const args = argumentsOf(call);
    if (name === "mysql2" && method === "query") return mysqlQuery(args);
    return fromSql(queryText(args[0]));
  }
  return SAFE_METHODS[name]!.includes(method) ? [] : unknown;
}

/**
 * mysql2's query() builds the statement in the client: it pastes each value, escaped, into
 * the text at its placeholder (execute() and prepare() bind them instead). A value whose
 * `toSqlString()` method is pasted in as SQL (what mysql.raw() returns) can touch any table,
 * so every value must be one mysql2 escapes: see isPlainValue. And a placeholder in a string
 * or comment, which older versions fill in too, is unknown (sql-tables.ts).
 */
function mysqlQuery(args: readonly Node[]): Capability[] {
  const [first, second] = args;
  const values = [second, first && optionValues(first)].filter((v): v is Node => v !== undefined && !isCallback(v));
  if (!values.every(isPlainValue)) return unknown;
  // Without values, nothing is pasted in.
  return fromSql(queryText(first), { formatted: values.length > 0 });
}

/** `values` in a `{ sql, values }` options object; a spread or computed key could set it. */
function optionValues(arg: Node): Node | undefined {
  const options = unwrapExpression(arg);
  if (!Node.isObjectLiteralExpression(options)) return undefined;
  const value = propertyValue(options, "values");
  return value === "absent" ? undefined : value === "unknown" ? options : value;
}

function isCallback(arg: Node): boolean {
  return unwrapExpression(arg).getType().getCallSignatures().length > 0;
}

/**
 * Whether mysql2 pastes a value into the query escaped, as data: a string, number, boolean,
 * null, Date, or Buffer, and arrays and records of those, at any depth. Any other object
 * could have a `toSqlString()` method, whatever its declared type says: an interface or a
 * parameter's object type describes some of an object's members, not all of them. So do
 * `object`, `unknown`, `any`, and a generic. Read from the expression where it's written
 * (an array or object literal, element by element) and otherwise from its type; a cast is
 * looked through, since it doesn't change the value.
 */
function isPlainValue(value: Node): boolean {
  const inner = unwrapExpression(value);
  if (Node.isArrayLiteralExpression(inner)) {
    return inner.getElements().every((e) => (Node.isSpreadElement(e) ? isPlainType(e.getExpression().getType(), e) : isPlainValue(e)));
  }
  if (Node.isObjectLiteralExpression(inner)) {
    return inner.getProperties().every((p) => {
      if (Node.isPropertyAssignment(p)) return isPlainValue(p.getInitializerOrThrow());
      if (Node.isShorthandPropertyAssignment(p)) return isPlainType(p.getType(), p);
      if (Node.isSpreadAssignment(p)) return isPlainType(p.getExpression().getType(), p);
      return false; // a method or accessor: `toSqlString() { ... }`
    });
  }
  return isPlainType(inner.getType(), inner);
}

function isPlainType(type: Type, at: Node, seen = new Set<object>()): boolean {
  if (type.isAny() || type.isUnknown()) return false;
  if (seen.has(type.compilerType)) return true; // a recursive type, checked where it started
  seen.add(type.compilerType);
  if (type.isUnion()) return type.getUnionTypes().every((t) => isPlainType(t, at, seen));
  if (type.isString() || type.isNumber() || type.isBoolean() || type.isBigInt() || type.isNull() || type.isUndefined()) return true;
  if (type.isLiteral() || type.isBooleanLiteral() || type.isEnum() || type.isEnumLiteral() || type.isTemplateLiteral()) return true;
  if (type.isTypeParameter()) {
    const constraint = type.getConstraint();
    return constraint !== undefined && isPlainType(constraint, at, seen);
  }
  // mysql2 escapes these before it looks for toSqlString(), whatever subclass they are.
  if (isPlatformClass(type, ["Date", "Buffer", "Uint8Array"])) return true;
  if (type.isArray() || type.isTuple()) {
    const elements = type.isArray() ? [type.getArrayElementTypeOrThrow()] : type.getTupleElements();
    return elements.every((t) => isPlainType(t, at, seen));
  }
  if (!type.isObject() || type.getCallSignatures().length > 0) return false;
  const members = type.getProperties().map((p) => p.getTypeAtLocation(at));
  // A record, `Record<string, string>`, holds only members of its value type; an object made
  // by an object literal holds the members written in it. Other object types can hold more.
  const index = type.getStringIndexType();
  const literal = type.getSymbol()?.getDeclarations().some((d) => Node.isObjectLiteralExpression(d)) === true;
  if (index === undefined && !literal) return false;
  return (index === undefined || isPlainType(index, at, seen)) && members.every((t) => isPlainType(t, at, seen));
}

/** A class from the TypeScript lib or Node's types, by name: not a project class called `Date`. */
function isPlatformClass(type: Type, names: readonly string[]): boolean {
  const symbol = type.getSymbol();
  if (!symbol || !names.includes(symbol.getName())) return false;
  const declarations = symbol.getDeclarations();
  return declarations.length > 0 && declarations.every((d) => /\/node_modules\/(typescript\/lib|@types\/node)\//.test(d.getSourceFile().getFilePath()));
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

function fromSql(sql: string | undefined, options?: SqlOptions): Capability[] {
  const tables = sql === undefined ? undefined : sqlTables(sql, options);
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
