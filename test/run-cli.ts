// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Runs the permlang command in this process, as a shell in `cwd` would: the exit code, and
// what it printed (stderr too, when it fails). Faster than starting a process per run, and
// coverage sees the code. test/cli.test.ts also runs the real executable.

import { format } from "node:util";
import { vi } from "vitest";
import { main } from "../src/main.js";

type Options = { cwd: string; env?: Record<string, string | undefined> };

export function runCli(args: string[], options: Options): { code: number; out: string } {
  const { code, stdout, stderr } = runCliStreams(args, options);
  return { code, out: code === 0 ? stdout : stdout + stderr };
}

/** The same, with standard output and standard error apart. */
export function runCliStreams(args: string[], options: Options): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(`${format(...a)}\n`));
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(`${format(...a)}\n`));
  // As outside GitHub Actions, wherever the tests run, unless a test says otherwise: in Actions,
  // PermLang tells the runner to ignore workflow commands while it runs.
  const env = { GITHUB_ACTIONS: undefined, ...options.env };
  const saved = { cwd: process.cwd(), env: Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) };
  process.chdir(options.cwd);
  setEnv(env);
  let code: number;
  try {
    code = main(args);
  } catch (e) {
    // main() catches everything, so this is a bug in it: reported as the crash it would be.
    stderr.push(`${(e as Error).stack ?? String(e)}\n`);
    code = 1;
  } finally {
    process.chdir(saved.cwd);
    setEnv(saved.env);
    log.mockRestore();
    error.mockRestore();
  }
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
