// SARIF output: `permlang check --sarif <file>` writes findings in the format GitHub's code
// scanning reads, so they appear in the repository's Security tab next to CodeQL's.

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnostic, Report } from "../src/check.js";
import { toSarif } from "../src/report.js";

const root = path.resolve("/repo");
const diagnostic = (d: Partial<Diagnostic>): Diagnostic => ({
  severity: "error",
  code: "PERM005",
  file: path.join(root, "src", "leads.ts"),
  line: 21,
  column: 21,
  function: "enrich",
  capability: "net(api.data-broker.io)",
  call: "",
  message: "enrich can now reach net(api.data-broker.io), which permlang.lock.json doesn't record.",
  fix: "run `permlang lock` and commit the change so reviewers see it.",
  ...d,
});
const report = (diagnostics: Diagnostic[]): Report => ({ files: 1, functions: [], units: [], diagnostics, unsafe: [], unmapped: [], unresolved: [] }) as unknown as Report;

interface Sarif {
  version: string;
  $schema: string;
  runs: {
    tool: { driver: { name: string; version: string; informationUri: string; rules: { id: string; shortDescription: { text: string }; helpUri: string }[] } };
    results: {
      ruleId: string;
      ruleIndex: number;
      level: string;
      message: { text: string };
      locations: { physicalLocation: { artifactLocation: { uri: string; uriBaseId: string }; region: { startLine: number; startColumn: number } } }[];
      properties: { capability: string; function: string };
    }[];
  }[];
}

describe("SARIF output", () => {
  const sarif = JSON.parse(toSarif(report([diagnostic({}), diagnostic({ severity: "warning", code: "PERM006", line: 3, column: 1, capability: "mystery-sdk" })]), root, "0.2.2")) as Sarif;
  const run = sarif.runs[0]!;

  it("is SARIF 2.1.0 from PermLang", () => {
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toMatch(/sarif-2\.1\.0/);
    expect(run.tool.driver).toMatchObject({ name: "PermLang", version: "0.2.2", informationUri: "https://github.com/PermLang/PermLang" });
  });

  it("describes each rule that occurs, once, with a link to the reference", () => {
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["PERM005", "PERM006"]);
    expect(run.tool.driver.rules[0]!.shortDescription.text).toMatch(/lock/);
    expect(run.tool.driver.rules[0]!.helpUri).toMatch(/^https:\/\/github\.com\/PermLang\/PermLang\/blob\/main\/docs\/reference\.md/);
  });

  it("gives each finding its rule, level, message with the fix, and location from the repository root", () => {
    expect(run.results[0]).toMatchObject({
      ruleId: "PERM005",
      ruleIndex: 0,
      level: "error",
      message: { text: expect.stringContaining("Fix: run `permlang lock`") },
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/leads.ts", uriBaseId: "%SRCROOT%" }, region: { startLine: 21, startColumn: 21 } } }],
      properties: { capability: "net(api.data-broker.io)", function: "enrich" },
    });
    expect(run.results[1]).toMatchObject({ ruleId: "PERM006", ruleIndex: 1, level: "warning" });
  });

  // SARIF locations are URIs: a space, `#`, or `%` in a file name must be percent-encoded, or
  // code scanning reads a different path (found in the code review, O5).
  it("percent-encodes each part of the path", () => {
    const odd = JSON.parse(toSarif(report([diagnostic({ file: path.join(root, "my lib", "a#b%c?.ts") })]), root, "0.2.2")) as Sarif;
    expect(odd.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri).toBe("my%20lib/a%23b%25c%3F.ts");
  });

  it("is an empty run when there are no findings, so stale alerts close", () => {
    const empty = JSON.parse(toSarif(report([]), root, "0.2.2")) as Sarif;
    expect(empty.runs[0]!.results).toEqual([]);
    expect(empty.runs[0]!.tool.driver.rules).toEqual([]);
  });
});
