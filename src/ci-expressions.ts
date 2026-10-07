// GitHub Actions expressions (`${{ ... }}`), read the way GitHub reads them: found with
// its own scan of a string, split into tokens by the same rules as its lexer (in
// actions/languageservices), and with context and property names in any case.
//
// Only what the lock needs is read out of them: which secrets an expression reads, and
// the plain text a `${{ 'text' }}` value stands for.

const OPEN = "${{";

/** The source of each `${{ ... }}` in `text`. An unclosed one (an error to GitHub) runs to the end. */
export function expressionsIn(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf(OPEN); start !== -1; ) {
    const end = closing(text, start);
    if (end === -1) {
      out.push(text.slice(start + OPEN.length));
      break;
    }
    out.push(text.slice(start + OPEN.length, end - 1));
    start = text.indexOf(OPEN, end + 1);
  }
  return out;
}

/** Where the `${{` at `start` closes (the index of its last `}`), or -1. A `}}` inside quotes doesn't count. */
function closing(text: string, start: number): number {
  let quoted = false;
  for (let i = start + OPEN.length; i < text.length; i++) {
    if (text[i] === "'") quoted = !quoted; // '' (an escaped quote) toggles twice
    else if (!quoted && text[i] === "}" && text[i - 1] === "}") return i;
  }
  return -1;
}

/**
 * The text a key or value stands for. GitHub reads a scalar that is exactly one
 * expression holding only a string literal, `${{ 'pull_request_target' }}`, as that
 * string, wherever it's written, even where expressions aren't allowed.
 */
export function literalOf(text: string): string {
  if (!text.startsWith(OPEN) || closing(text, 0) !== text.length - 1) return text;
  const inner = text.slice(OPEN.length, -2).trim();
  // Only quoted text, with '' for a quote: anything outside the quotes makes it a real expression.
  let quoted = false;
  let value = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "'") {
      quoted = !quoted;
      if (quoted && i !== 0) value += "'";
    } else if (!quoted) return text;
    else value += inner[i];
  }
  return inner !== "" && !quoted ? value : text;
}

/**
 * The secrets an expression reads: each name written literally (`secrets.NAME`,
 * `secrets['NAME']`), in upper case as GitHub stores it, and `all` for any other use
 * of the context (`secrets[matrix.name]`, `secrets.*`, `toJSON(secrets)`), whose names
 * can't be known from the file. Context and property names match in any case, and
 * spaces between tokens don't matter: `SECRETS . name` is `secrets.NAME`.
 */
export function secretsRead(expression: string): string[] {
  const tokens = tokenize(expression);
  const out: string[] = [];
  tokens.forEach((t, i) => {
    // `secrets` itself, not a property of something else (`github.secrets`).
    if (t.kind !== "word" || t.text.toLowerCase() !== "secrets" || tokens[i - 1]?.text === ".") return;
    const [a, b, c] = [tokens[i + 1], tokens[i + 2], tokens[i + 3]];
    if (a?.text === "." && b?.kind === "word" && IDENTIFIER.test(b.text)) out.push(b.text.toUpperCase());
    else if (a?.text === "[" && b?.kind === "string" && c?.text === "]") out.push(b.value!.toUpperCase());
    else out.push("all");
  });
  return out;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PUNCTUATION = "()[],.!<>=&|*";

interface Token {
  kind: "word" | "string" | "punctuation";
  text: string;
  /** A string's contents. */
  value?: string;
}

// Whitespace as .NET defines it, which is how the runner splits an expression: JavaScript's
// `\s` leaves out U+0085, so `secrets<U+0085>.KEY` read as one word, and no secret.
const SPACE = /[\s\u0085]/;

/**
 * GitHub's lexer, simplified to what finding `secrets` needs: whitespace separates
 * tokens, strings are quoted (with '' for a quote), and anything else runs to the next
 * punctuation or space. It never fails: what GitHub would reject is still split up and
 * read, so nothing in it is skipped. Double quotes, an error to GitHub, are read as quotes.
 */
function tokenize(expression: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < expression.length; ) {
    const c = expression[i]!;
    if (SPACE.test(c)) {
      i++;
    } else if (c === "'" || c === '"') {
      let value = "";
      let j = i + 1;
      for (; j < expression.length; j++) {
        if (expression[j] !== c) value += expression[j];
        else if (expression[j + 1] === c) value += expression[j++];
        else break;
      }
      out.push({ kind: "string", text: expression.slice(i, j + 1), value });
      i = j + 1;
    } else if (PUNCTUATION.includes(c)) {
      out.push({ kind: "punctuation", text: c });
      i++;
    } else {
      let j = i + 1;
      while (j < expression.length && !PUNCTUATION.includes(expression[j]!) && !SPACE.test(expression[j]!) && !`'"`.includes(expression[j]!)) j++;
      out.push({ kind: "word", text: expression.slice(i, j) });
      i = j;
    }
  }
  return out;
}
