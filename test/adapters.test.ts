import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterError, builtinAdapterPaths, loadAdapters, parseManifest } from "../src/adapters.js";

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
