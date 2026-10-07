// YAML as GitHub reads workflow and Action files. Its parser (actions/languageservices)
// uses this same `yaml` library, with YAML 1.2's core schema whatever a `%YAML`
// directive says, so `on:` is the key "on", never `true`. It resolves anchors and
// aliases (supported since 2025) before reading any value, keys included. And for every
// key and value, `${{ 'text' }}` reads as the text, and a number or boolean as its string.
//
// Merge keys (`<<: *defaults`) are YAML 1.1, and GitHub rejects them today. They're
// expanded here anyway, as YAML 1.1 would, so that nothing they bring in goes
// unrecorded if GitHub ever accepts them. A merged key doesn't replace one written
// out: both are read, which can only record more.
//
// The runner, which reads Actions, parses with YamlDotNet instead. Like YAML 1.1, it also
// ends a line at U+0085, U+2028 and U+2029, which this library reads as ordinary
// characters: after `#note<U+2028>`, one reads a key and the other more comment. Where
// the two can disagree, the file is unverifiable (see ambiguousBreak).

import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, Scalar, visit, type Alias, type Document, type Node as YamlNode, type Pair, type ParsedNode, type YAMLMap } from "yaml";
import { literalOf } from "./ci-expressions.js";

export interface Position {
  line: number;
  column: number;
}

/** A value as GitHub reads it (an alias replaced by its anchored node), and where to report it. */
export interface Value {
  node: YamlNode | null | undefined;
  /** Where it's written, or where the alias that brought it in is: that's the line a change adds. */
  at: Position;
  /** Reached through an alias, so everything inside reports the alias's position. */
  borrowed: boolean;
}

/** One key of a mapping, read as GitHub reads keys. */
export interface Field {
  key: string;
  at: Position;
  value: Value;
}

export class YamlFile {
  readonly doc: Document.Parsed;
  /** Aliases that can't be followed: GitHub can't run the file, or reads it some way PermLang can't. */
  readonly problems: { why: string; at: Position }[] = [];
  private readonly lines = new LineCounter();
  private readonly targets = new Map<Alias, YamlNode>();

  /** `text` may start with a byte-order mark: YAML allows one, and the parser skips it. */
  constructor(private readonly source: string) {
    this.doc = parseDocument(source, { lineCounter: this.lines, uniqueKeys: false, schema: "core" });
    this.resolveAliases();
  }

  /** Parsed without errors into a mapping, as every workflow and Action is. */
  get readable(): boolean {
    return this.doc.errors.length === 0 && isMap(this.doc.contents);
  }

  /** The first line break YamlDotNet sees and this parser doesn't, if the file has one. */
  ambiguousBreak(): Position | undefined {
    const i = this.source.search(/[\u0085\u2028\u2029]/);
    if (i === -1) return undefined;
    const { line, col } = this.lines.linePos(i);
    return { line, column: col };
  }

  root(): Value {
    return { node: this.doc.contents, at: { line: 1, column: 1 }, borrowed: false };
  }

  /** A mapping's keys and values, with merge keys expanded. Empty for anything else. */
  fields(v: Value, seen = new Set<YAMLMap>()): Field[] {
    if (!isMap(v.node) || seen.has(v.node)) return [];
    seen.add(v.node);
    const out: Field[] = [];
    for (const pair of v.node.items) {
      const at = v.borrowed ? v.at : this.position(pair);
      const sources = this.mergeSources(pair);
      if (sources) {
        for (const source of sources) out.push(...this.fields({ node: source, at, borrowed: true }, seen));
        continue;
      }
      const key = this.text(this.deref(pair.key as YamlNode | null));
      if (key !== undefined) out.push({ key, at, value: this.value(pair.value as YamlNode | null, at, v.borrowed) });
    }
    return out;
  }

  /** Every value of `key` in a mapping. GitHub rejects a repeated key, so reading each one is safe. */
  get(v: Value, key: string): Value[] {
    return this.fields(v)
      .filter((f) => f.key === key)
      .map((f) => f.value);
  }

  /** A sequence's items. Empty for anything else. */
  items(v: Value): Value[] {
    if (!isSeq(v.node)) return [];
    return v.node.items.map((item) => this.value(item as YamlNode | null, v.borrowed ? v.at : this.position(item as YamlNode), v.borrowed));
  }

  /** A scalar's text as GitHub reads it; undefined for a mapping, a sequence, or nothing at all. */
  text(node: YamlNode | null | undefined): string | undefined {
    if (!isScalar(node)) return undefined;
    if (typeof node.value === "string") return literalOf(node.value);
    return node.value === null ? "" : String(node.value);
  }

  /** Where a parsed node, or a pair's key, starts. Every parsed node has a range. */
  position(node: YamlNode | Pair): Position {
    const { range } = (isPair(node) ? node.key : node) as ParsedNode;
    const { line, col } = this.lines.linePos(range[0]);
    return { line, column: col };
  }

  /** A value written at `at`: through an alias, everything inside is reported there too. */
  private value(node: YamlNode | null, at: Position, borrowed: boolean): Value {
    if (isAlias(node)) return { node: this.deref(node), at, borrowed: true };
    return { node, at: borrowed || !node ? at : this.position(node), borrowed };
  }

  private deref(node: YamlNode | null | undefined): YamlNode | null | undefined {
    return isAlias(node) ? this.targets.get(node) : node;
  }

  /** The maps a plain `<<` key merges in, or undefined when it's an ordinary key (its value isn't maps). */
  private mergeSources(pair: Pair): YAMLMap[] | undefined {
    const key = pair.key;
    if (!(key instanceof Scalar) || key.type !== Scalar.PLAIN || key.value !== "<<") return undefined;
    const value = this.deref(pair.value as YamlNode | null);
    const sources = isSeq(value) ? value.items.map((item) => this.deref(item as YamlNode | null)) : [value];
    return sources.every((s) => isMap(s)) ? (sources as YAMLMap[]) : undefined;
  }

  /**
   * Each alias's anchored node: the last node with that anchor before it, as YAML
   * defines and GitHub follows. One that has none, or sits inside the node it names (so
   * reading it would never end), is a problem: GitHub rejects or drops it.
   */
  private resolveAliases() {
    const anchors = new Map<string, YamlNode>();
    visit(this.doc, {
      Node: (_, node, path) => {
        if (isAlias(node)) {
          const target = anchors.get(node.source);
          if (!target) this.problems.push({ why: `*${node.source} has no anchor before it`, at: this.position(node) });
          else if (path.includes(target)) this.problems.push({ why: `*${node.source} is inside the node it names`, at: this.position(node) });
          else this.targets.set(node, target);
        } else if (node.anchor) {
          anchors.set(node.anchor, node);
        }
      },
    });
  }
}
