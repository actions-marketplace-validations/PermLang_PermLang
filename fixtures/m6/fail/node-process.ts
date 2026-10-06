import cluster from "node:cluster";
import * as crypto from "node:crypto";
import * as inspector from "node:inspector";
import Module, { register, registerHooks } from "node:module";

// Found in the 0.3 review: process and cluster methods are interface members (Process.kill,
// Cluster.fork), which the adapters' keys didn't match, and newer process APIs weren't mapped.
/** @perm env(MODE) */
export function processes(pid: number) {
  process.kill(pid, "SIGKILL"); // expect: error PERM001 exec
  process.execve!("/bin/sh", ["sh", "-c", "id"]); // expect: error PERM001 exec
  cluster.fork(); // expect: error PERM001 exec
  cluster.setupPrimary({ exec: "/bin/sh" }); // expect: error PERM001 exec
}

// Code the checker can't see: native addons, the inspector, module hooks, OpenSSL engines.
/** @perm env(MODE) */
export function code(session: inspector.Session, name: string) {
  process.dlopen({ exports: {} }, "./addon.node"); // expect: error PERM004 unverifiable
  session.post("Runtime.evaluate", { expression: name }); // expect: error PERM004 unverifiable
  process.getBuiltinModule(name as "path").join("a"); // expect: error PERM004 unverifiable
  register("./hooks.mjs", import.meta.url); // expect: error PERM004 unverifiable
  registerHooks({}); // expect: error PERM004 unverifiable
  Module.runMain(name); // expect: error PERM004 unverifiable
  crypto.setEngine(name); // expect: error PERM004 unverifiable
}

// loadEnvFile reads a file into the environment; chdir changes where every relative path points.
/** @perm env(MODE) */
export function files() {
  process.loadEnvFile(); // expect: error PERM001 fs.read(./.env) expect: error PERM001 env
  process.loadEnvFile("./config/.env.local"); // expect: error PERM001 fs.read(./config/.env.local) expect: error PERM001 env
  process.chdir("/srv/other"); // expect: error PERM001 fs.read(/srv/other) expect: error PERM001 fs.write(/srv/other)
}

// A path that isn't literal, or the function passed along to be called with any path.
/** @perm env */
export function envFiles(path: string) {
  process.loadEnvFile(path); // expect: error PERM001 fs.read
  [".env.local", ".env"].forEach(process.loadEnvFile); // expect: error PERM001 fs.read
}

// Internal bindings that the types don't declare can spawn processes.
/** @perm env(MODE) */
export function bindings() {
  // @ts-expect-error not in the types
  process.binding("spawn_sync"); // expect: error PERM004 unverifiable
  (process as any)._linkedBinding("x"); // expect: error PERM004 unverifiable
}
