// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

/**
 * Run by the GitHub Action, before the check, to bring in the packages another job installed.
 * What it does is in dependencies.ts, which the tests run directly.
 * @module
 * @perm fs.read, fs.write, exec
 */

import { importCommand } from "./dependencies.js";

process.exitCode = importCommand(process.argv.slice(2));
