// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// What a diagnostic says about Drizzle SQL read back out of a schema object: the code that
// reads it, shortened when it's long, as other diagnostics shorten code.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkFiles } from "../src/check.js";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));

it("names a long read back out of a schema object, shortened", () => {
  const file = path.join(fixtures, "m10/fail/drizzle-schema-sql.ts");
  const report = checkFiles([path.join(fixtures, "m7/types/drizzle.d.ts"), file]);
  const line = 53; // pgPolicy("leads_visible_only_to_their_owners", ...).using
  const messages = report.diagnostics.filter((d) => path.resolve(d.file) === path.resolve(file) && d.line === line).map((d) => d.message.split("\n")[0]);
  const shown = 'pgPolicy("leads_visible_only_to_their_owners", { using: sql`EXISTS ...';
  expect(shown).toHaveLength(70);
  expect(messages).toEqual([`readBack reads ${shown}`, `readBack reads ${shown}`]);
});
