// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Writes PermLang's software bill of materials (SBOM), in CycloneDX JSON: every package that
// installing PermLang installs, at the version package-lock.json pins, with its license and
// checksum. The release workflow attaches it to each release, and CI makes it on every pull
// request, so a change that breaks it shows up before a release does.
//
//   npm run sbom -- <out.cdx.json>
//
// npm makes it, in a temporary folder that has only the published dependencies installed.
// `npm sbom --omit=dev` can't be used on the repository: it leaves out packages that a
// development tool also uses (yaml, for one). So the result is checked against
// package-lock.json, and a mismatch fails instead of shipping a wrong list.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("Usage: npm run sbom -- <out.cdx.json>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

// Run as `npm run sbom`, the npm that runs it, which also works on Windows, where npm on the
// PATH is a .cmd file that only a shell runs; otherwise, the npm on the PATH.
const npm = (args, cwd) => {
  const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
  const cli = process.env.npm_execpath;
  return cli ? execFileSync(process.execPath, [cli, ...args], options) : execFileSync("npm", args, options);
};

const temp = mkdtempSync(path.join(tmpdir(), "permlang-sbom-"));
let text;
try {
  // npm names the SBOM's package after the folder it runs in.
  const dir = path.join(temp, pkg.name);
  mkdirSync(dir);
  copyFileSync("package.json", path.join(dir, "package.json"));
  copyFileSync("package-lock.json", path.join(dir, "package-lock.json"));
  npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  // npm sbom stops at a dependency package.json lists but isn't installed, as development tools aren't.
  const published = { ...pkg };
  delete published.devDependencies;
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(published, null, 2));
  text = npm(["sbom", "--sbom-format", "cyclonedx"], dir);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const problems = mismatches(JSON.parse(text));
if (problems.length > 0) {
  console.error(`::error::The SBOM doesn't match package-lock.json: ${problems.join("; ")}.`);
  process.exit(1);
}
writeFileSync(out, text);
console.log(`Wrote ${out}: the ${expectedPackages().size} packages that installing ${lock.name}@${lock.version} installs.`);

/** Every package installing PermLang installs, as name@version: those not marked as development tools. */
function expectedPackages() {
  const prefix = "node_modules/";
  return new Set(
    Object.entries(lock.packages)
      .filter(([key, entry]) => key !== "" && !entry.dev && !entry.devOptional)
      .map(([key, entry]) => `${key.slice(key.lastIndexOf(prefix) + prefix.length)}@${entry.version}`),
  );
}

/** How an SBOM differs from package-lock.json; empty when it lists exactly what installing PermLang installs. */
function mismatches(sbom) {
  const problems = [];
  const root = sbom.metadata?.component;
  if (root?.name !== lock.name || root?.version !== lock.version) {
    problems.push(`it describes ${root?.name}@${root?.version}, not ${lock.name}@${lock.version}`);
  }
  const expected = expectedPackages();
  const listed = new Set((sbom.components ?? []).map((c) => `${c.group ? `${c.group}/` : ""}${c.name}@${c.version}`));
  const missing = [...expected].filter((p) => !listed.has(p));
  if (missing.length > 0) problems.push(`it leaves out ${missing.join(", ")}`);
  const extra = [...listed].filter((p) => !expected.has(p));
  if (extra.length > 0) problems.push(`it lists ${extra.join(", ")}, which installing PermLang doesn't install`);
  return problems;
}
