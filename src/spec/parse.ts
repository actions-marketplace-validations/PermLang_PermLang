// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// The PermLang spec format (.perm files): rules, examples, and permissions for
// one piece of logic, in one language-neutral file. Phase 2 groundwork: see
// docs/spec-format.md.
//
//   perm process_refund(order: Order, reason: Text) -> RefundResult
//     implements: src/refunds.ts#processRefund
//
//     must:
//       refund only orders paid within the last 30 days
//
//     examples:
//       order(paid: $120, 5 days ago) -> refunded($120)
//
//     perms:
//       db.read(orders), db.write(refunds)
//
// A file holds any number of `perm` blocks. Lines starting with `#` are comments.

import { AdapterIndex, loadAdapters } from "../adapters.js";
import { parsePermList, type Capability } from "../capability.js";

export interface SpecLine {
  text: string;
  line: number;
}

export interface SpecExample extends SpecLine {
  input: string;
  expected: string;
}

export interface Spec {
  name: string;
  /** Everything after the name on the header line, e.g. "(order: Order) -> RefundResult". */
  signature: string;
  file: string;
  line: number;
  /** The code that implements the spec: a path relative to the spec file, and a function. */
  implements?: { file: string; symbol: string; line: number };
  must: SpecLine[];
  examples: SpecExample[];
  perms: Capability[];
}

export interface SpecError {
  file: string;
  line: number;
  message: string;
}

const HEADER = /^perm\s+([A-Za-z_][\w.]*)\s*(.*)$/;
const SECTION = /^([A-Za-z_]\w*):\s*(.*)$/;
const SECTIONS = new Set(["implements", "must", "examples", "perms"]);

let defaultVocabulary: ReadonlySet<string> | undefined;

/**
 * `vocabulary` is the set of capability names; by default, the built-ins plus the
 * built-in adapters', which are read from disk the first time.
 * @perm fs.read
 */
export function parseSpecs(text: string, file: string, vocabulary?: ReadonlySet<string>): { specs: Spec[]; errors: SpecError[] } {
  const known = vocabulary ?? (defaultVocabulary ??= new AdapterIndex(loadAdapters([]).adapters).vocabulary);
  const specs: Spec[] = [];
  const errors: SpecError[] = [];
  const fail = (line: number, message: string) => errors.push({ file, line, message });

  let spec: Spec | undefined;
  let sawPerms = false;
  let section: string | undefined;
  let sectionIndent = -1;

  const finish = () => {
    if (spec && !sawPerms) fail(spec.line, `perm ${spec.name} has no perms: section`);
  };

  // Editors on Windows may save a byte-order mark, which would hide the first header.
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0) {
      const header = HEADER.exec(trimmed);
      if (!header || !balanced(header[2]!)) {
        fail(line, trimmed.startsWith("perm") ? "malformed perm header; expected: perm name(params) -> Result" : `expected a "perm" header, found "${trimmed}"`);
        return;
      }
      finish();
      spec = { name: header[1]!, signature: header[2]!.trim(), file, line, must: [], examples: [], perms: [] };
      specs.push(spec);
      sawPerms = false;
      section = undefined;
      sectionIndent = -1;
      return;
    }

    if (!spec) {
      fail(line, 'this line comes before any "perm" header');
      return;
    }

    // An indented header would otherwise be read as content and hide a spec.
    if (HEADER.test(trimmed)) {
      fail(line, 'a "perm" header must start at the beginning of the line');
      return;
    }

    // A section header sits at the block's first indentation; its content is indented further.
    const heading = SECTION.exec(trimmed);
    if (heading && (sectionIndent === -1 || indent <= sectionIndent)) {
      sectionIndent = indent;
      const [, name, inline] = heading as unknown as [string, string, string];
      if (!SECTIONS.has(name)) {
        fail(line, `unknown section "${name}"; expected implements, must, examples, or perms`);
        section = undefined;
        return;
      }
      section = name;
      if (name === "perms") sawPerms = true;
      if (inline) content(spec, name, inline, line);
      return;
    }
    if (!section) {
      fail(line, "expected a section: implements, must, examples, or perms");
      return;
    }
    content(spec, section, trimmed, line);
  });
  finish();
  return { specs, errors };

  function content(target: Spec, name: string, value: string, line: number) {
    if (name === "implements") {
      const m = /^(.+)#([A-Za-z_$][\w$.<>]*)$/.exec(value);
      if (!m) fail(line, `implements must be path#function, e.g. src/refunds.ts#processRefund; found "${value}"`);
      else if (target.implements) fail(line, `perm ${target.name} has more than one implements: line; a spec checks one function`);
      else target.implements = { file: m[1]!.trim(), symbol: m[2]!, line };
    } else if (name === "must") {
      target.must.push({ text: value, line });
    } else if (name === "examples") {
      const arrow = value.indexOf("->");
      if (arrow === -1) fail(line, `an example is input -> expected; expected "->" in "${value}"`);
      else target.examples.push({ text: value, line, input: value.slice(0, arrow).trim(), expected: value.slice(arrow + 2).trim() });
    } else if (name === "perms") {
      const { capabilities, errors: permErrors } = parsePermList(value.replace(/,\s*$/, ""), known);
      target.perms.push(...capabilities);
      for (const e of permErrors) fail(line, `invalid permission "${e.text}": ${e.reason}`);
    }
  }
}

function balanced(signature: string): boolean {
  let depth = 0;
  for (const c of signature) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}
