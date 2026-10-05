import { describe, expect, it } from "vitest";
import { covers, formatCapability, parsePermList, type Capability } from "../src/capability.js";

const cap = (name: string, arg?: string): Capability => ({ name, arg });

describe("parsePermList", () => {
  it("parses a comma-separated list", () => {
    const { capabilities, errors } = parsePermList("net(api.stripe.com), db.write(leads), env(STRIPE_KEY), exec");
    expect(errors).toEqual([]);
    expect(capabilities.map(formatCapability)).toEqual([
      "net(api.stripe.com)",
      "db.write(leads)",
      "env(STRIPE_KEY)",
      "exec",
    ]);
  });

  it("records the offset of each entry", () => {
    const { errors } = parsePermList("net, email.send(team)");
    expect(errors).toEqual([expect.objectContaining({ text: "email.send(team)", offset: 5 })]);
  });

  it.each([
    ["*", /wildcard/],
    ["fs.read(*.json)", /wildcard/],
    ["email.send", /unknown capability/],
    ["net(a.com", /malformed/],
    ["exec(ls)", /takes no argument/],
    ["env()", /empty argument/],
    ["", /empty @perm/],
  ])("rejects %j", (text, reason) => {
    const { errors } = parsePermList(text);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toMatch(reason);
  });
});

describe("covers", () => {
  it("matches hosts exactly, ignoring case", () => {
    expect(covers([cap("net", "api.stripe.com")], cap("net", "API.Stripe.com"))).toBe(true);
    expect(covers([cap("net", "stripe.com")], cap("net", "api.stripe.com"))).toBe(false);
  });

  it("requires bare net for an unknown host", () => {
    expect(covers([cap("net", "api.stripe.com")], cap("net"))).toBe(false);
    expect(covers([cap("net")], cap("net"))).toBe(true);
    expect(covers([cap("net")], cap("net", "anything.io"))).toBe(true);
  });

  it("matches paths by directory prefix on segment boundaries", () => {
    expect(covers([cap("fs.read", "./data")], cap("fs.read", "data/a/b.json"))).toBe(true);
    expect(covers([cap("fs.read", "./data/")], cap("fs.read", "./data"))).toBe(true);
    expect(covers([cap("fs.read", "./data")], cap("fs.read", "./database.json"))).toBe(false);
    expect(covers([cap("fs.read", "./data")], cap("fs.read", "./data/../x"))).toBe(false);
    expect(covers([cap("fs.read", "/var/app")], cap("fs.read", "var/app/x"))).toBe(false);
  });

  it("lets a folder above the working directory cover only what's beneath it", () => {
    expect(covers([cap("fs.read", "..")], cap("fs.read", "../shared/x"))).toBe(true);
    expect(covers([cap("fs.read", "..")], cap("fs.read", "data/x"))).toBe(true);
    expect(covers([cap("fs.read", "..")], cap("fs.read", "../../secrets"))).toBe(false);
    expect(covers([cap("fs.read", "../..")], cap("fs.read", "../../../etc/passwd"))).toBe(false);
    expect(covers([cap("fs.read", ".")], cap("fs.read", "../x"))).toBe(false);
  });

  it("treats Windows drive paths as absolute", () => {
    expect(covers([cap("fs.read", ".")], cap("fs.read", "C:\\Windows\\system.ini"))).toBe(false);
    expect(covers([cap("fs.read", "C:\\data")], cap("fs.read", "C:/data/x.json"))).toBe(true);
    expect(covers([cap("fs.read", "C:/data")], cap("fs.read", "C:/data/../../x"))).toBe(false);
  });

  it("does not let one capability stand in for another", () => {
    expect(covers([cap("fs.read", "./data")], cap("fs.write", "./data/x"))).toBe(false);
    expect(covers([cap("db.read", "leads")], cap("db.write", "leads"))).toBe(false);
  });
});
