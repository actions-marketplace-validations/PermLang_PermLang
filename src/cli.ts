#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

/**
 * The permlang command. What it does is in main.ts, which the tests run directly.
 * @module
 * @perm fs.read, fs.write, exec, env(GITHUB_WORKSPACE), env(GITHUB_ACTIONS)
 */

import { main } from "./main.js";

process.exitCode = main(process.argv.slice(2));
