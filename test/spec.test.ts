// PermLang specs (phase 2 groundwork): rules, examples, and permissions for one
// piece of logic in one language-neutral file. Today the permissions are checked
// against the implementation; rules and examples are parsed and reported as not
// yet verified.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, checkTsConfig } from "../src/check.js";
import { checkSpecs, formatSpecResults } from "../src/spec/check.js";
import { parseSpecs } from "../src/spec/parse.js";

const dir = fileURLToPath(new URL("./spec-fixtures/", import.meta.url));
const specFile = path.join(dir, "refunds.perm");
const source = readFileSync(specFile, "utf8");

describe("parsing .perm files", () => {
  it("reads each spec's signature, implementation, rules, examples, and permissions", () => {
    const { specs, errors } = parseSpecs(source, specFile);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(2);
    const [refund, notify] = specs;
    expect(refund).toMatchObject({
      name: "process_refund",
      signature: "(order: Order, reason: Text) -> RefundResult",
      line: 3,
      implements: { file: "src/refunds.ts", symbol: "processRefund" },
    });
    expect(refund!.must.map((r) => r.text)).toEqual([
      "refund only orders paid within the last 30 days",
      "never refund more than the amount paid",
      "refunds over $500 require manager approval",
    ]);
    expect(refund!.examples[1]).toMatchObject({ input: "order(paid: $120, 45 days ago)", expected: 'denied("outside 30-day window")' });
    expect(refund!.perms.map((p) => p.name + (p.arg ? `(${p.arg})` : ""))).toEqual(["db.read(orders)", "db.write(refunds)", "email.send"]);
    expect(notify).toMatchObject({ name: "notify_team", must: [], examples: [] });
  });

  it.each([
    ["perm x()\n  perms:\n    net(*)\n", /wildcards/],
    ["perm x()\n  implements: nowhere\n  perms:\n    net\n", /implements.*path#function/],
    ["perm x()\n  wishes:\n    a pony\n", /unknown section "wishes"/],
    ["perm x()\n  examples:\n    no arrow here\n  perms:\n    net\n", /expected "->"/],
    ["perm x()\n  must:\n    be good\n", /no perms: section/],
    ["  perms:\n    net\n", /before any "perm"/],
    ["perm (broken\n", /malformed perm header/],
    // Found in the second review: a later implements: replaced an earlier one, and an
    // indented header was swallowed, so a spec could pass without checking its function.
    ["perm x()\n  implements: src/x.ts#dangerous\n  perms:\n    net\n  implements: src/x.ts#safe\n", /more than one implements/],
    ["perm a()\n  implements: src/x.ts#dangerous\n  must:\n    be good\n  perm b()\n  perms:\n    net\n", /must start at the beginning/],
  ])("reports %j", (text, reason) => {
    const { errors } = parseSpecs(text, "bad.perm");
    expect(errors.map((e) => `${e.line}: ${e.message}`).join("\n")).toMatch(reason);
  });
});

describe("checking specs against code", () => {
  const report = checkFiles([path.join(dir, "src", "refunds.ts"), path.join(dir, "prisma-and-mail.d.ts")], { strictness: "sketch" });
  const { specs } = parseSpecs(source, specFile);
  const results = checkSpecs(specs, report);

  it("passes when the implementation stays within the spec's permissions", () => {
    const refund = results.find((r) => r.spec.name === "process_refund")!;
    expect(refund.diagnostics).toEqual([]);
    expect(refund.status).toBe("perms ok");
  });

  it("fails when the implementation reaches beyond them, and names the access", () => {
    const notify = results.find((r) => r.spec.name === "notify_team")!;
    expect(notify.status).toBe("perms exceeded");
    expect(notify.diagnostics.map((d) => `${d.severity} ${d.code} ${d.capability}`)).toEqual([
      "error SPEC003 net(analytics.example)",
      "warning SPEC004 email.send",
    ]);
  });

  it("never reports rules or examples as verified", () => {
    const refund = results.find((r) => r.spec.name === "process_refund")!;
    expect(refund.must).toEqual({ count: 3, verified: false });
    expect(refund.examples).toEqual({ count: 2, run: false });
  });

  it("reports a spec whose implementation can't be found", () => {
    const { specs: missing } = parseSpecs("perm x()\n  implements: src/refunds.ts#nope\n  perms:\n    net\n", specFile);
    const [result] = checkSpecs(missing, report);
    expect(result!.diagnostics.map((d) => d.code)).toEqual(["SPEC002"]);
  });
});

describe("specs that can't be checked as written", () => {
  // Found in review: a .perm file saved with a byte-order mark failed to parse.
  it("reads a file that starts with a UTF-8 byte-order mark", () => {
    const { specs, errors } = parseSpecs("\uFEFFperm x()\n  implements: src/x.ts#x\n  perms:\n    net\n", "bom.perm");
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.name)).toEqual(["x"]);
  });

  // Found in review: with two functions named build, the spec checked the first and ignored the second.
  describe("an implementation name that matches more than one function", () => {
    const report = checkFiles([path.join(dir, "src", "reports.ts")], { strictness: "sketch" });
    const check = (symbol: string, perms = "net(api.example.com)") =>
      checkSpecs(parseSpecs(`perm build()\n  implements: src/reports.ts#${symbol}\n  perms:\n    ${perms}\n`, specFile).specs, report)[0]!;

    it("fails, and asks for the qualified name", () => {
      const result = check("build");
      expect(result.status).toBe("ambiguous");
      expect(result.diagnostics.map((d) => `${d.severity} ${d.code}`)).toEqual(["error SPEC002"]);
      expect(result.diagnostics[0]!.message).toBe(
        "perm build: src/reports.ts#build matches 2 functions: Reports.build (line 5), Admin.build (line 11), so it's not clear which one implements the spec.",
      );
      expect(result.diagnostics[0]!.fix).toBe("write the qualified name, such as implements: src/reports.ts#Reports.build.");
      expect(formatSpecResults([result], dir)).toContain("perms     implementation is ambiguous: write its qualified name");
    });

    it("checks the one a qualified name picks", () => {
      expect(check("Reports.build").status).toBe("perms ok");
      expect(check("Admin.build").diagnostics.map((d) => `${d.code} ${d.capability}`)).toEqual(["SPEC003 exec", "SPEC004 net(api.example.com)"]);
    });

    it("checks a getter and setter of the same property together", () => {
      const result = check("Settings.theme");
      expect(result.status).toBe("perms exceeded");
      expect(result.diagnostics.filter((d) => d.code === "SPEC003").map((d) => d.capability)).toEqual(["exec"]);
    });
  });

  // Found in review: without Node's types, an implementation that runs execSync passed.
  describe("an implementation that reaches code PermLang can't see", () => {
    const notypes = path.join(dir, "notypes");
    const report = checkTsConfig(path.join(notypes, "tsconfig.json"), { strictness: "sketch" });
    const { specs } = parseSpecs(readFileSync(path.join(notypes, "refund.perm"), "utf8"), path.join(notypes, "refund.perm"));
    const results = checkSpecs(specs, report);
    const result = (name: string) => results.find((r) => r.spec.name === name)!;

    it("is unchecked, and fails, naming what can't be seen", () => {
      const refund = result("process_refund");
      expect(refund.status).toBe("unchecked");
      expect(refund.diagnostics.map((d) => `${d.severity} ${d.code}`)).toEqual(["error SPEC005"]);
      expect(refund.diagnostics[0]!.message).toBe(
        "perm process_refund: processRefund reaches code PermLang can't see, so its permissions can't be checked: it calls into node:child_process, whose types can't be found.",
      );
      expect(refund.diagnostics[0]!.fix).toBe("install the missing types (@types/node for Node's modules and globals, such as process), then run it again.");
    });

    it("covers globals with no declaration, and code reached through helpers", () => {
      expect(result("read_key").diagnostics[0]!.message).toMatch(/: it uses process, which has no declaration\.$/);
      expect(result("refund_and_notify").status).toBe("unchecked");
      expect(result("refund_and_notify").diagnostics[0]!.message).toMatch(/: it calls into node:child_process, whose types can't be found \(through notifyOps\)\.$/);
    });

    it("covers import x = require() and import()", () => {
      expect(result("host_name").diagnostics[0]!.message).toMatch(/: it calls into node:os, whose types can't be found.$/);
      expect(result("load_plugin").diagnostics[0]!.message).toMatch(/: it calls into untyped-plugin, whose types can't be found.$/);
    });

    it("doesn't mark an implementation that reaches none of it, even in the same file", () => {
      expect(result("format_amount").status).toBe("perms ok");
    });

    it("doesn't report unused permissions it can't confirm", () => {
      expect(result("read_key").diagnostics.map((d) => d.code)).not.toContain("SPEC004");
    });

    it("counts as failing in the summary", () => {
      expect(formatSpecResults(results, notypes)).toContain("6 specs, 5 failing.");
      expect(formatSpecResults(results, notypes)).toContain("perms     unchecked: reaches code whose types can't be found");
    });
  });
});
