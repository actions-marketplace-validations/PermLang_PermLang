#!/usr/bin/env node
/**
 * The permlang command. What it does is in main.ts, which the tests run directly.
 * @module
 * @perm fs.read, fs.write, exec, env(GITHUB_WORKSPACE)
 */

import { main } from "./main.js";

process.exitCode = main(process.argv.slice(2));
