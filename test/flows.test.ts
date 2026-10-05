// Data-flow rules: "env(STRIPE_KEY) may only go to net(api.stripe.com)". A function that
// reads the source and can send to any other host, directly or through what it calls,
// fails. This first version works per function; it doesn't follow the value itself.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type CheckOptions } from "../src/check.js";

const app = fileURLToPath(new URL("./flows-fixtures/app.ts", import.meta.url));
const stripeRule = { from: { name: "env", arg: "STRIPE_KEY" }, to: [{ name: "net", arg: "api.stripe.com" }] };
const run = (options: CheckOptions = {}) => checkFiles([app], { flows: [stripeRule], ...options });
const flows = (options: CheckOptions = {}) => run(options).diagnostics.filter((d) => d.code === "PERM009");

describe("data-flow rules", () => {
  it("fails functions that read the source and can send it to another host", () => {
    expect(flows().map((d) => `${d.severity} ${d.function}:${d.line} ${d.capability}`)).toEqual([
      "error charge:7 net(analytics.example)",
      "error relay:17 net",
      "error dumpAll:22 net(logs.example)",
    ]);
  });

  it("says what was read, where it can go, and the path to it", () => {
    const charge = flows().find((d) => d.function === "charge")!;
    expect(charge.message).toBe(
      "charge reads env(STRIPE_KEY) and can send to net(analytics.example), through track → fetch(\"https://analytics.example/event\", ...), which the flow rule for env(STRIPE_KEY) doesn't allow.",
    );
    expect(charge.fix).toBe("keep env(STRIPE_KEY) away from that call, or add net(analytics.example) to the rule's \"to\" in permlang.config.json.");
    expect(flows().find((d) => d.function === "relay")!.message).toContain("can send to net (a host that can't be determined)");
  });

  it("allows the hosts the rule lists, and ignores functions that don't read the source", () => {
    const functions = flows().map((d) => d.function);
    expect(functions).not.toContain("stripeOnly");
    expect(functions).not.toContain("other");
    expect(functions).not.toContain("track");
    // It calls stripeOnly, which reads the key, but the key stays inside stripeOnly.
    expect(functions).not.toContain("dashboard");
  });

  it("is a warning in sketch, like everything else", () => {
    expect(flows({ strictness: "sketch" }).every((d) => d.severity === "warning")).toBe(true);
  });

  it("checks nothing without rules", () => {
    expect(checkFiles([app]).diagnostics.filter((d) => d.code === "PERM009")).toEqual([]);
  });

  it("can take a whole category as the source", () => {
    const anyEnv = { from: { name: "env" }, to: [{ name: "net", arg: "api.stripe.com" }] };
    expect(flows({ flows: [anyEnv] }).map((d) => d.function)).toContain("other");
  });
});

describe("data-flow rules in permlang.config.json", () => {
  it("are read and validated by the CLI", async () => {
    const { parseFlows } = await import("../src/flows.js");
    expect(parseFlows([{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com)"] }], "permlang.config.json")).toEqual([stripeRule]);
    expect(() => parseFlows([{ from: "env(STRIPE_KEY)" }], "permlang.config.json")).toThrow(/"to" must be a list/);
    expect(() => parseFlows([{ from: "nonsense(", to: [] }], "permlang.config.json")).toThrow(/invalid "from"/);
    expect(() => parseFlows("x", "permlang.config.json")).toThrow(/"flows" must be a list/);
    expect(path.basename(app)).toBe("app.ts");
  });
});
