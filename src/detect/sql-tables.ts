// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Table names read out of a literal SQL statement, for raw-SQL database clients.
//
// This fails closed. It gives a definite answer only for one SELECT, INSERT,
// UPDATE, or DELETE in shapes it fully understands, and `undefined` (unknown) for
// everything else, which then needs bare db.read and db.write. A pattern-based
// version gave confident wrong answers for comma joins, quotes inside identifiers,
// MySQL comments, and more (found in review); this one tokenizes first, so quotes
// and comments are handled exactly once, and rejects whatever it doesn't expect.
// Where dialects read the same text differently (MySQL's `--` and double quotes,
// executable comments), it is unknown: one of them could read more tables.

export interface SqlTables {
  read: string[];
  write: string[];
}

export interface SqlOptions {
  /**
   * The client pastes each value into the text at its placeholder before sending it, as
   * mysql2's query() does. A placeholder inside a string, quoted name, or comment is then
   * unknown: older clients fill those in too, and a value pasted there can end the string
   * and run as SQL.
   */
  formatted?: boolean;
}

class Unknown extends Error {}
const unknown = (): never => {
  throw new Unknown();
};

/** Undefined when the statement can't be analyzed with confidence. */
export function sqlTables(sql: string, options: SqlOptions = {}): SqlTables | undefined {
  try {
    return analyze(tokenize(sql, options));
  } catch (e) {
    if (e instanceof Unknown) return undefined;
    throw e;
  }
}

// --- tokens ------------------------------------------------------------------

type Token =
  | { kind: "word"; text: string; upper: string } // a bare word: keyword or name
  | { kind: "ident"; text: string } // a quoted identifier: "x", `x`, [x]
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "param" } // $1, ?, :name, @name
  | { kind: "punct"; text: string };

// [order details] is a name in SQLite and SQL Server; any other bracket is an array
// subscript or constructor (Postgres), whose contents are read like the rest.
const BRACKETED_NAME = /^\[[A-Za-z_][\w $]*\]/;

function tokenize(sql: string, { formatted = false }: SqlOptions): Token[] {
  const tokens: Token[] = [];
  // Where SQLite ends a token that runs past this tokenizer's view of the text: a `]`
  // or `)` that must be a token here too, so both are back in step after it.
  const boundaries: number[] = [];
  const punctAt = new Set<number>();
  // Text read as a string, quoted name, or comment: [start, end).
  const opaque: [number, number][] = [];
  let i = 0;
  const at = (k = 0) => sql[i + k] ?? "";
  while (i < sql.length) {
    const c = at();
    const start = i;
    if (c === "$" || c === ":" || c === "@") {
      const end = sqliteSuffixEnd(sql, i);
      if (end !== undefined) boundaries.push(end);
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
    } else if (c === "-" && at(1) === "-") {
      // MySQL needs ASCII whitespace or a control character after --: there, `1--1`
      // is 1 minus -1 and the line goes on.
      if (i + 2 < sql.length && !/[\x00-\x20]/.test(at(2))) unknown();
      // Postgres also ends the comment at a lone \r, which MySQL and SQLite don't.
      while (i < sql.length && at() !== "\n") {
        if (at() === "\r" && at(1) !== "\n") unknown();
        i++;
      }
      opaque.push([start, i]);
    } else if (c === "/" && at(1) === "*") {
      // MySQL runs /*! ... */ and MariaDB /*M! ... */ as SQL; nesting differs by dialect.
      if (at(2) === "!" || at(2) === "+" || (at(2) === "M" && at(3) === "!")) unknown();
      const end = sql.indexOf("*/", i + 2);
      if (end === -1 || sql.slice(i + 2, end).includes("/*")) unknown();
      i = end + 2;
      opaque.push([start, i]);
    } else if (c === "#") {
      unknown(); // a MySQL comment, or a Postgres operator: dialect-dependent
    } else if (c === "'") {
      // E'...' strings and backslashes change escaping by dialect.
      const prev = tokens[tokens.length - 1];
      if (prev?.kind === "word" && /^E$/i.test(prev.text) && sql[i - 1] !== " ") unknown();
      const end = endOfQuoted(sql, i, "'", "'");
      if (sql.slice(i + 1, end - 1).includes("\\")) unknown();
      i = end;
      tokens.push({ kind: "string" });
      opaque.push([start, i]);
    } else if (c === '"' || c === "`") {
      // U&"..." names a table other than the one written (Postgres unicode escapes).
      if (c === '"' && sql[i - 1] === "&") unknown();
      const end = endOfQuoted(sql, i, c, c);
      tokens.push({ kind: "ident", text: quotedName(sql.slice(i + 1, end - 1).replaceAll(c + c, c)) });
      i = end;
      opaque.push([start, i]);
    } else if (c === "[" && BRACKETED_NAME.test(sql.slice(i, i + 130))) {
      const end = sql.indexOf("]", i);
      tokens.push({ kind: "ident", text: quotedName(sql.slice(i + 1, end)) });
      i = end + 1;
      opaque.push([start, i]);
    } else if (c === "$") {
      const m = /^\$\d+/.exec(sql.slice(i));
      if (!m) unknown(); // $tag$ dollar quoting
      tokens.push({ kind: "param" });
      i += m![0].length;
    } else if (c === "?") {
      // SQLite's ?NNN. MySQL and SQLite read `?` on its own, so a word after it
      // (`?FROM`) is the next token, not part of the placeholder.
      i++;
      while (/[0-9]/.test(at())) i++;
      tokens.push({ kind: "param" });
    } else if (c === ":" && at(1) === ":") {
      // A Postgres cast, `x::numeric(10,2)`: the type after it is a word, not a placeholder.
      tokens.push({ kind: "punct", text: "::" });
      punctAt.add(i);
      i += 2;
    } else if ((c === ":" || c === "@") && /[A-Za-z_]/.test(at(1))) {
      i++;
      while (/[A-Za-z0-9_]/.test(at())) i++;
      tokens.push({ kind: "param" });
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))!;
      tokens.push({ kind: "word", text: m[0], upper: m[0].toUpperCase() });
      i += m[0].length;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(at(1)))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i))!;
      tokens.push({ kind: "number" });
      i += m[0].length;
    } else if ("(),.;=<>!+-*/%|&^~:[]".includes(c)) {
      // SQLite reads `[` to the first `]` as a name, whatever is between them.
      if (c === "[" && sql.indexOf("]", i) !== -1) boundaries.push(sql.indexOf("]", i));
      tokens.push({ kind: "punct", text: c });
      punctAt.add(i);
      i++;
    } else {
      unknown(); // non-ASCII names, odd whitespace, anything unexpected
    }
  }
  if (boundaries.some((b) => !punctAt.has(b))) unknown();
  if (formatted) checkFilledIn(sql, opaque);
  return tokens;
}

/**
 * Where SQLite ends a variable that starts at `start` (`$`, `:`, or `@`), when it ends in
 * a Tcl-style suffix: the name runs over identifier characters and `::`, and a `(` after
 * it runs to the first `)` with no whitespace before it (sqlite3GetToken). That suffix is
 * part of the variable there, so a quote inside it starts no string; returns its `)`.
 */
function sqliteSuffixEnd(sql: string, start: number): number | undefined {
  let named = false;
  for (let i = start + 1; i < sql.length; i++) {
    const c = sql[i]!;
    if (/[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80) {
      named = true;
    } else if (c === "(" && named) {
      for (let j = i + 1; j < sql.length; j++) {
        if (sql[j] === ")") return j;
        if (" \t\n\v\f\r".includes(sql[j]!)) return undefined; // SQLite rejects the variable
      }
      return undefined;
    } else if (c === ":" && sql[i + 1] === ":") {
      i++;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/**
 * For a client that fills in placeholders itself: one inside a string, quoted name, or
 * comment is unknown. Any `?` there (older mysql2 versions fill in every one), and any
 * `:name` the named-placeholders package would fill in there.
 */
function checkFilledIn(sql: string, opaque: readonly [number, number][]): void {
  const inside = (p: number) => opaque.some(([from, to]) => p >= from && p < to);
  if (opaque.some(([from, to]) => sql.slice(from, to).includes("?"))) unknown();
  if (namedPlaceholders(sql).some(inside)) unknown();
}

/**
 * Where mysql2's named-placeholders package (`namedPlaceholders: true`) finds a `:name`,
 * as it does: outside '...' and "...", tracked with backslash escapes, and nowhere else
 * (not comments, not backticks). A port of its parse loop.
 */
function namedPlaceholders(sql: string): number[] {
  const found: number[] = [];
  const pattern = /\?|:(?:\d+|[a-zA-Z][a-zA-Z0-9_]*)/g;
  let inQuote = false;
  let escaped = false;
  let quote = "";
  let from = 0;
  for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
    for (let i = from; i < match.index; i++) {
      const c = sql[i]!;
      if (c === "\\") {
        escaped = !escaped;
      } else if (escaped) {
        escaped = false;
      } else if (inQuote && c === quote) {
        // named-placeholders skips a doubled quote; closing and reopening the string is the same.
        inQuote = false;
      } else if (!inQuote && (c === "'" || c === '"')) {
        inQuote = true;
        quote = c;
      }
    }
    if (!inQuote && match[0] !== "?") found.push(match.index);
    from = match.index + match[0].length;
  }
  return found;
}

/**
 * A quoted name, when it can be reported as written. One that is empty, has spaces
 * at its ends, or holds a dot, comma, parenthesis, or control character could pass
 * for another name (the table "audit.log" isn't schema audit's log) or couldn't be
 * declared in @perm. A backslash is unknown too: MySQL reads "a\" ..." as a string
 * whose backslash escapes the quote, so the text after it is still in the string.
 */
function quotedName(text: string): string {
  if (text === "" || text.trim() !== text || /[\x00-\x1f.,()*\\]/.test(text)) unknown();
  return text;
}

/** The index after a quoted run starting at `start`; a doubled quote is an escaped quote. */
function endOfQuoted(sql: string, start: number, open: string, close: string): number {
  let i = start + open.length;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] === close) i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return unknown();
}

// --- grammar -----------------------------------------------------------------

// Keywords that can hide a table or a write, or whose shape isn't analyzed.
const REJECT = new Set(["UNION", "INTERSECT", "EXCEPT", "WITH", "WINDOW", "LATERAL", "OUTFILE", "DUMPFILE", "TABLE", "INTO", "USING"]);
// Words that end a FROM clause.
const CLAUSE_END = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "FOR", "RETURNING", "SET", "ON"]);
const JOIN_WORDS = new Set(["NATURAL", "LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS", "JOIN", "STRAIGHT_JOIN"]);
// Words that can't be a table alias.
const RESERVED = new Set([...CLAUSE_END, ...JOIN_WORDS, ...REJECT, "USING", "SELECT", "FROM", "VALUES", "AND", "OR", "NOT", "AS", "WHEN", "THEN", "ELSE", "END", "CONFLICT", "DUPLICATE"]);
// Calls known not to touch other tables, files, or state. Anything else is unknown,
// as is any of these qualified by a schema or quoted (`evil.lower(x)`, `"lower"(x)`),
// which can be a function of the same name that does.
const PURE_CALLS = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "GREATEST", "LEAST", "IFNULL", "NVL", "IF",
  "LOWER", "UPPER", "LENGTH", "CHAR_LENGTH", "TRIM", "LTRIM", "RTRIM", "SUBSTRING", "SUBSTR", "CONCAT",
  "CONCAT_WS", "REPLACE", "POSITION", "LEFT", "RIGHT", "EXTRACT", "DATE_TRUNC", "DATE_PART", "NOW",
  "ABS", "ROUND", "FLOOR", "CEIL", "CEILING", "MOD", "POWER", "SQRT", "CAST", "TO_CHAR", "TO_DATE",
  "TO_TIMESTAMP", "DATE", "JSON_BUILD_OBJECT", "JSONB_BUILD_OBJECT", "JSON_AGG", "JSONB_AGG",
  "ARRAY_AGG", "STRING_AGG", "GROUP_CONCAT", "ROW_NUMBER", "RANK", "DENSE_RANK",
  // Built-in clocks and generators, common in column defaults: Postgres's, MySQL's, SQLite's.
  "GEN_RANDOM_UUID", "RANDOM", "RAND", "UUID", "CLOCK_TIMESTAMP", "STATEMENT_TIMESTAMP",
  "TRANSACTION_TIMESTAMP", "CURRENT_TIMESTAMP", "UTC_TIMESTAMP", "UNIXEPOCH", "DATETIME", "STRFTIME",
  "JULIANDAY",
  // Syntax that takes parentheses.
  "IN", "EXISTS", "ANY", "ALL", "SOME", "VALUES", "ARRAY", "ROW", "OVER", "FILTER", "CONFLICT",
]);
// A "(" after these is grouping or a subquery, not a call: SELECT (SELECT ...), AND (a OR b).
const GROUPING_KEYWORDS = new Set([
  "SELECT", "WHERE", "AND", "OR", "NOT", "ON", "WHEN", "THEN", "ELSE", "CASE", "BY", "HAVING", "AS",
  "DISTINCT", "IS", "LIKE", "ILIKE", "BETWEEN", "SET", "RETURNING", "LIMIT", "OFFSET",
]);
// FROM inside these calls is part of the call: EXTRACT(YEAR FROM d).
const CALLS_WITH_FROM = new Set(["EXTRACT", "SUBSTRING", "TRIM", "OVERLAY", "POSITION"]);
// Deeper nesting is unknown, which also keeps the recursion off the stack's limit.
const MAX_DEPTH = 64;

function analyze(all: Token[]): SqlTables {
  // One statement, with an optional trailing semicolon.
  let tokens = all;
  const semi = tokens.findIndex((t) => t.kind === "punct" && t.text === ";");
  if (semi !== -1) {
    if (tokens.slice(semi + 1).length > 0) unknown();
    tokens = tokens.slice(0, semi);
  }
  if (tokens.length === 0) return { read: [], write: [] };

  const match = matchParens(tokens);
  const read: string[] = [];
  const write: string[] = [];
  let depth = 0;
  const word = (i: number) => (tokens[i]?.kind === "word" ? (tokens[i] as { upper: string }).upper : undefined);
  const isPunct = (i: number, text: string) => tokens[i]?.kind === "punct" && (tokens[i] as { text: string }).text === text;

  /** A possibly qualified table name at i; returns [name, next index]. */
  const tableName = (i: number, columnList = false): [string, number] => {
    const parts: string[] = [];
    for (;;) {
      const t = tokens[i];
      if (t?.kind === "ident") parts.push(t.text);
      else if (t?.kind === "word" && !RESERVED.has(t.upper)) parts.push(t.text);
      else unknown();
      i++;
      if (isPunct(i, ".")) i++;
      else break;
    }
    if (isPunct(i, "(") && !columnList) unknown(); // a table function (INSERT's column list is fine)
    return [parts.join("."), i];
  };

  /** A parenthesized list of names at i, `(a, "b", c)`; returns the index after it. Anything else in it is unknown. */
  const nameList = (i: number): number => {
    const close = match[i]!;
    for (let j = i + 1; j < close; j++) {
      const t = tokens[j]!;
      const isName = t.kind === "ident" || (t.kind === "word" && !RESERVED.has(t.upper));
      if ((j - i) % 2 === 1 ? !isName : !isPunct(j, ",")) unknown();
    }
    return close + 1;
  };

  /** An optional alias, `AS x` or `x`, possibly with a column list. */
  const alias = (i: number): number => {
    if (word(i) === "AS") i++;
    const t = tokens[i];
    if (t?.kind === "ident" || (t?.kind === "word" && !RESERVED.has(t.upper))) {
      i++;
      if (isPunct(i, "(")) i = nameList(i);
    } else if (tokens[i - 1] && word(i - 1) === "AS") {
      unknown();
    }
    return i;
  };

  /** One FROM or JOIN item: a table or a parenthesized subquery. */
  const factor = (i: number, end: number): number => {
    if (word(i) === "ONLY") i++;
    if (isPunct(i, "(")) {
      const close = match[i]!;
      if (word(i + 1) !== "SELECT") unknown();
      scan(i + 1, close, undefined);
      return alias(close + 1);
    }
    const [name, next] = tableName(i);
    if (next > end) unknown();
    read.push(name);
    return alias(next);
  };

  /** A FROM clause starting at i; returns the index of whatever ends it. */
  const fromClause = (i: number, end: number): number => {
    i = factor(i, end);
    while (i < end) {
      const w = word(i);
      if (isPunct(i, ",")) {
        i = factor(i + 1, end);
      } else if (w && JOIN_WORDS.has(w)) {
        while (word(i) && word(i) !== "JOIN" && word(i) !== "STRAIGHT_JOIN" && JOIN_WORDS.has(word(i)!)) i++;
        if (word(i) !== "JOIN" && word(i) !== "STRAIGHT_JOIN") unknown();
        i = factor(i + 1, end);
        if (word(i) === "USING") {
          if (!isPunct(i + 1, "(")) unknown();
          i = nameList(i + 1);
        }
      } else if (w === "ON") {
        // The join condition runs to the next join, comma, or clause at this depth.
        let j = i + 1;
        while (j < end && !isPunct(j, ",") && !(word(j) && (JOIN_WORDS.has(word(j)!) || (CLAUSE_END.has(word(j)!) && word(j) !== "ON")))) {
          j = isPunct(j, "(") ? match[j]! + 1 : j + 1;
        }
        scan(i + 1, j, undefined);
        i = j;
      } else if (w && CLAUSE_END.has(w)) {
        return i;
      } else {
        unknown();
      }
    }
    return i;
  };

  /** Checks tokens [start, end) at one depth; `call` is the function whose arguments these are. */
  const scan = (start: number, end: number, call: string | undefined): void => {
    if (++depth > MAX_DEPTH) unknown();
    for (let i = start; i < end; i++) {
      const t = tokens[i]!;
      if (t.kind === "punct" && t.text === "(") {
        const prev = tokens[i - 1];
        // A quoted or schema-qualified name before "(" is a call to a function PermLang can't know.
        if (prev?.kind === "ident" || (prev?.kind === "word" && isPunct(i - 2, "."))) unknown();
        // So is a name read as a placeholder: Postgres reads `@f(...)` as the operator @ and a
        // call of f, and `[1:f(...)]` as a slice that ends in one. A number before "(" is never SQL.
        if (prev?.kind === "param" || prev?.kind === "number") unknown();
        // After a cast, `::numeric(10,2)`, the parentheses hold the type's modifiers.
        const isType = isPunct(i - 2, "::");
        const name = prev?.kind === "word" && !GROUPING_KEYWORDS.has(prev.upper) && !isType ? prev.upper : undefined;
        if (name !== undefined && !PURE_CALLS.has(name)) unknown();
        scan(i + 1, match[i]!, name);
        i = match[i]!;
        continue;
      }
      if (t.kind !== "word") continue;
      if (REJECT.has(t.upper) || JOIN_WORDS.has(t.upper) && t.upper !== "LEFT" && t.upper !== "RIGHT") {
        unknown();
      }
      if (t.upper === "FROM") {
        if (call !== undefined && CALLS_WITH_FROM.has(call)) continue;
        if (word(i - 1) === "DISTINCT" && (word(i - 2) === "IS" || word(i - 3) === "IS")) continue;
        i = fromClause(i + 1, end) - 1;
      }
    }
    depth--;
  };

  const first = word(0);
  let i = 1;
  if (first === "SELECT") {
    scan(1, tokens.length, undefined);
  } else if (first === "INSERT" || first === "REPLACE") {
    while (word(i) && ["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"].includes(word(i)!)) i++;
    if (word(i) === "OR") i += 2; // INSERT OR REPLACE / IGNORE / ABORT (SQLite)
    if (word(i) === "INTO") i++;
    const [name, next] = tableName(i, true);
    write.push(name);
    i = next;
    if (word(i) === "AS") i = alias(i);
    // A column list, never the source: INSERT INTO a (SELECT * FROM b) is unknown.
    if (isPunct(i, "(")) i = nameList(i);
    scan(i, tokens.length, undefined);
  } else if (first === "UPDATE") {
    while (word(i) && ["LOW_PRIORITY", "IGNORE", "ONLY"].includes(word(i)!)) i++;
    const [name, next] = tableName(i);
    write.push(name);
    i = alias(next);
    if (word(i) !== "SET") unknown(); // UPDATE a, b SET ... (MySQL multi-table)
    scan(i, tokens.length, undefined);
  } else if (first === "DELETE") {
    while (word(i) && ["LOW_PRIORITY", "QUICK", "IGNORE"].includes(word(i)!)) i++;
    if (word(i) !== "FROM") unknown(); // DELETE t FROM ... (MySQL multi-table)
    i++;
    if (word(i) === "ONLY") i++;
    const [name, next] = tableName(i);
    write.push(name);
    scan(alias(next), tokens.length, undefined);
  } else {
    unknown();
  }

  return { read: [...new Set(read)], write: [...new Set(write)] };
}

function matchParens(tokens: Token[]): (number | undefined)[] {
  const match: (number | undefined)[] = [];
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.kind !== "punct") return;
    if (t.text === "(") stack.push(i);
    else if (t.text === ")") {
      const open = stack.pop();
      if (open === undefined) unknown();
      match[open!] = i;
      match[i] = open;
    }
  });
  if (stack.length > 0) unknown();
  return match;
}
