// GitHub annotations: `permlang check --annotations` adds a workflow command per
// diagnostic, so each one shows on its line in a pull request's "Files changed" tab.

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic, Report } from "../src/check.js";
import { formatAnnotations } from "../src/report.js";

const root = path.resolve("/repo");
/** A right-to-left override, which makes text read differently than it is. */
const RLO = String.fromCharCode(0x202e);
const diagnostic = (d: Partial<Diagnostic>): Diagnostic => ({
  severity: "error",
  code: "PERM001",
  file: path.join(root, "src", "leads.ts"),
  line: 9,
  column: 9,
  function: "handleLead",
  capability: "net(data-broker.io)",
  call: "fetch(...)",
  message: "handleLead calls fetch(\"https://data-broker.io/enrich\")\n  but its declared permissions do not include net(data-broker.io).",
  fix: "add net(data-broker.io) to @perm, or remove the call.",
  ...d,
});
const report = (diagnostics: Diagnostic[]): Report => ({ files: 1, functions: [], units: [], diagnostics, unsafe: [], unmapped: [], unresolved: [] }) as unknown as Report;

describe("GitHub annotations", () => {
  it("writes one workflow command per diagnostic, on its file and line, relative to the repository", () => {
    expect(formatAnnotations(report([diagnostic({})]), root)).toBe(
      "::error file=src/leads.ts,line=9,col=9,title=PermLang PERM001%3A net(data-broker.io)::" +
        "handleLead calls fetch(\"https://data-broker.io/enrich\")%0Abut its declared permissions do not include net(data-broker.io).%0A-> add net(data-broker.io) to @perm, or remove the call.",
    );
  });

  it("lists errors before warnings, since GitHub shows only the first few of each", () => {
    const out = formatAnnotations(report([diagnostic({ severity: "warning", code: "PERM006" }), diagnostic({ code: "PERM005" })]), root).split("\n");
    expect(out.map((l) => l.slice(0, l.indexOf(" ")))).toEqual(["::error", "::warning"]);
  });

  it("escapes code text, so a message can't start a workflow command of its own", () => {
    const hostile = diagnostic({ message: "calls x()\n::add-mask::secret\r::error::fake", capability: "net(a,b:c)" });
    const out = formatAnnotations(report([hostile]), root);
    expect(out.split("\n")).toHaveLength(1);
    // Shown as the text report shows it: a line break in code text is `\n`, not a new line.
    expect(out).toContain("calls x()\\n%3A%3Aadd-mask%3A%3Asecret\\r%3A%3Aerror%3A%3Afake".replaceAll("%3A", ":"));
    expect(out).toContain("title=PermLang PERM001%3A net(a%2Cb%3Ac)");
    // Escape sequences and bidirectional overrides reached the log raw (the second verification, item 5).
    const control = formatAnnotations(report([diagnostic({ message: `calls x(\u001b[31m${RLO})`, capability: "fs.read(\u001b)", fix: `see ${RLO}` })]), root);
    expect(control).toContain("calls x(\\u001b[31m\\u202e)");
    expect(control).toContain("title=PermLang PERM001%3A fs.read(\\u001b)");
    expect(control).toContain("-> see \\u202e");
    // PermLang's own break, before the reason, is still a line of the annotation.
    expect(formatAnnotations(report([diagnostic({ message: "f calls g()\n  but declares nothing" })]), root)).toContain("f calls g()%0Abut declares nothing");
    // A literal "%0A" in code text stays text, not a line break.
    expect(formatAnnotations(report([diagnostic({ message: "calls fetch(\"/a%0Ab\")", fix: "" })]), root)).toContain("::calls fetch(\"/a%250Ab\")");
  });

  it("writes nothing when there are no diagnostics", () => {
    expect(formatAnnotations(report([]), root)).toBe("");
  });
});
