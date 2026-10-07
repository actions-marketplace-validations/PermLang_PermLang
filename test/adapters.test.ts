import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { AdapterError, AdapterIndex, builtinAdapterPaths, loadAdapters, parseManifest } from "../src/adapters.js";

const valid = {
  permlang: 1,
  package: "@acme/sms",
  defines: ["sms.send"],
  functions: { sendSms: ["sms.send({arg:0})"] },
};

describe("adapter manifests", () => {
  it("accepts a valid manifest", () => {
    const { manifest, errors } = parseManifest(valid, "acme.json");
    expect(errors).toEqual([]);
    expect(manifest?.defines).toEqual(["sms.send"]);
  });

  it.each([
    [{ ...valid, permlang: 2 }, /unsupported manifest version/],
    [{ ...valid, package: "" }, /package/],
    [{ ...valid, defines: ["net"] }, /redefines built-in capability "net"/],
    [{ ...valid, defines: ["Sms Send"] }, /invalid capability name/],
    [{ ...valid, functions: { sendSms: ["sms.snd"] } }, /unknown capability "sms.snd"/],
    [{ ...valid, functions: { sendSms: ["sms.send({host:x})"] } }, /placeholder/],
    [{ ...valid, functions: { sendSms: ["net(*)"] } }, /wildcards/],
    [{ ...valid, functions: { sendSms: "sms.send" } }, /must be an array/],
    [{ ...valid, extra: true }, /unknown field "extra"/],
    [[valid], /a manifest must be a JSON object/],
    [{ ...valid, defines: "sms.send" }, /"defines" must be a list of capability names/],
    [{ ...valid, functions: ["sendSms"] }, /"functions" must be an object/],
    [{ ...valid, functions: { sendSms: [42] } }, /42 must be a string/],
    [{ ...valid, functions: { sendSms: ["(x)"] } }, /is not a capability/],
    [{ ...valid, functions: { sendSms: ["sms.send!"] } }, /malformed capability/],
    [{ ...valid, functions: { sendSms: ["sms.send({arg:0+})"] } }, /only \{host:N\+\} can be overridden/],
    [{ ...valid, functions: { sendSms: ["sms.send({arg:0?})"] } }, /only \{host:N\?\} can be left out/],
    [{ ...valid, default: "net" }, /"default" must be an array/],
  ])("rejects %j", (raw, reason) => {
    const { errors } = parseManifest(raw, "bad.json");
    expect(errors.join("\n")).toMatch(reason);
  });

  it("reports a manifest file that isn't JSON", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "permlang-adapter-")), "broken.json");
    writeFileSync(file, "{ not json");
    const { errors } = loadAdapters([file]);
    expect(errors).toEqual([expect.stringMatching(/broken\.json: .*JSON/)]);
    expect(new AdapterError(errors).message).toBe(`Invalid adapter manifest:\n  ${errors[0]}`);
  });

  it("ships built-in adapters that all validate", () => {
    const dir = fileURLToPath(new URL("../adapters", import.meta.url));
    expect(builtinAdapterPaths().length).toBe(readdirSync(dir).filter((f) => f.endsWith(".json")).length);
    const { errors, adapters } = loadAdapters([]);
    expect(errors).toEqual([]);
    expect(adapters.map((a) => a.package)).toEqual(
      expect.arrayContaining(["axios", "stripe", "nodemailer", "child_process", "http", "https"]),
    );
  });
});

// A folder of the project's with its own package.json is named by it, and only a team's own
// adapter covers it: that name could claim any package's (units.ts).
describe("adapters for a folder of the project's", () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const run = project.createSourceFile("/app/src/gen/db.d.ts", "export declare function run(cmd: string): void;\n").getFunctionOrThrow("run");
  const team = path.join(mkdtempSync(path.join(tmpdir(), "permlang-adapter-")), "acme.json");
  writeFileSync(team, JSON.stringify({ permlang: 1, package: "acme-client", default: ["exec"] }));
  const loaded = loadAdapters([team]).adapters;

  it("marks which adapters are a team's", () => {
    expect(loaded.filter((a) => a.team).map((a) => a.package)).toEqual(["acme-client"]);
  });

  it("maps a call into one by a team's adapter for its name, and by no other", () => {
    expect(new AdapterIndex(loaded, () => "acme-client").forDeclaration(run, [])).toEqual([{ name: "exec" }]);
    // Stripe's built-in adapter maps every function in the package to its API host.
    expect(new AdapterIndex(loaded, () => "stripe").forDeclaration(run, [])).toEqual([]);
    // Without a way to tell such folders apart, the declaration belongs to no package.
    expect(new AdapterIndex(loaded).forDeclaration(run, [])).toEqual([]);
  });
});
