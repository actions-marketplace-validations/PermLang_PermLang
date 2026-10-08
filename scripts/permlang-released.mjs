// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Runs the release of PermLang that .github/workflows/permlang.yml checks this repository with
// (its `released` job), for permlang.released.lock.json:
//
//   npm run permlang:released -- lock src --lock permlang.released.lock.json
//   npm run permlang:released -- check src --lock permlang.released.lock.json
//
// The version comes from the workflow's pin, so when Dependabot moves the pin to a new release,
// this runs that one. It's installed in the system's temporary folder: inside this repository,
// whose own package is also called permlang, npx would run the repository's copy instead.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workflow = readFileSync(new URL("../.github/workflows/permlang.yml", import.meta.url), "utf8");
const version = /PermLang\/permlang@[0-9a-f]{40} # v(\d+\.\d+\.\d+)/.exec(workflow)?.[1];
if (!version) {
  console.error("Couldn't find the released PermLang (PermLang/permlang@<commit> # v<version>) in .github/workflows/permlang.yml.");
  process.exit(2);
}

const dir = path.join(tmpdir(), `permlang-released-${version}`);
const cli = path.join(dir, "node_modules", "permlang", "dist", "cli.js");
if (!existsSync(cli)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), '{ "private": true }\n');
  execSync(`npm install permlang@${version} --ignore-scripts --no-audit --no-fund --silent`, { cwd: dir, stdio: "inherit" });
}

const run = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 2);
