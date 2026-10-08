// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Built-in APIs matched in code rather than by an adapter. They come from the
// TypeScript lib, @types/node, or undici-types (the types of Node's web globals),
// which have no adapter, and each needs more than a name match:
//
//   - WebSocket, EventSource, WebTransport, and WebSocketStream reach the host
//     they're given; navigator.sendBeacon and XMLHttpRequest's open send to theirs.
//   - The DOM's Worker and SharedWorker, importScripts() (also `self.importScripts`),
//     a service worker's register(), and a worklet's addModule() run a script the
//     checker can't see.
//   - setTimeout("code") evaluates its string, also as window.setTimeout. Where the
//     program has lib.dom's timers, so does a handler that may be a string (`any`,
//     `unknown`, `TimerHandler`), and a timer used as a value that may later be
//     given one (`codes.forEach(setTimeout)`). Node's timers throw on a string.
//   - process.getBuiltinModule(name) with a computed name could return any module;
//     process.loadEnvFile() reads a file (./.env by default) into the environment.
//   - fs's ReadStream and WriteStream open a file but declare no constructor of
//     their own, so they're matched by the class constructed (see fs.ts).
//
// Constructors are matched by the signature a call resolves to, not by name, so
// aliases (`const WS = WebSocket`), subclasses, `typeof WebSocket` parameters, and
// `super(url)` are covered too.

import { Node, SyntaxKind, type Type } from "ts-morph";
import { packageOf, type AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { fsCapabilities, fsStreamClass } from "./fs.js";
import { declarationCapabilities } from "./functions.js";
import { admitsString, argumentsOf, containerName, evaluatesString, hostOf, isGlobalLibFunction, literalString, signatureDeclarations, type CallLike } from "./shared.js";

const NETWORK_CLASSES = new Set(["WebSocket", "EventSource", "WebTransport", "WebSocketStream"]);
const SCRIPT_CLASSES = new Set(["Worker", "SharedWorker"]);
const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

const unverifiable: Capability = { name: UNVERIFIABLE };

/**
 * How a function is reached: called with arguments as written, called with arguments that
 * can't be read (`fn.apply(thisArg, list)`), used as a value (called later, with anything),
 * or used as a value that's only ever called with a function first
 * (`[handler].forEach(setTimeout)`).
 */
export type Reach = "called" | "called with unknown arguments" | "value" | "value given functions";

// Methods of the platform's interfaces that load a script the checker can't see, by interface.
const SCRIPT_LOADERS = new Map([["WorkerGlobalScope", "importScripts"], ["ServiceWorkerContainer", "register"], ["Worklet", "addModule"]]);

/** `declaration` is the resolved signature of `call`, if any. */
export function webCapabilities(call: CallLike, declaration: Node | undefined): Capability[] {
  const args = argumentsOf(call);
  if (Node.isNewExpression(call)) {
    const stream = fsStreamClass(call.getType());
    // A subclass's constructor may pass its base different arguments, so they aren't read.
    if (stream) return fsCapabilities(stream.name, stream.direct ? args : []);
  }
  return declaration ? platformCapabilities(declaration, args, "called") : [];
}

/** What reaching a platform API that needs code touches; [] if `declaration` isn't one. */
export function platformCapabilities(declaration: Node, args: readonly Node[], reach: Reach): Capability[] {
  const source = platformSource(declaration);
  if (!source) return [];
  const constructed = constructedClass(declaration);
  if (constructed !== undefined) {
    if (NETWORK_CLASSES.has(constructed)) return [net(args[0])];
    // Node's own Worker (worker_threads) has an adapter; this is the browser's.
    if (SCRIPT_CLASSES.has(constructed) && source !== "node") return [unverifiable];
    return [];
  }
  if (isGlobalLibFunction(declaration, "importScripts")) return [unverifiable];
  const name = "getName" in declaration ? (declaration as { getName(): string | undefined }).getName() : undefined;
  if (name === undefined) return [];
  if (TIMERS.has(name) && isTimer(declaration)) return timerEvaluates(declaration, args, reach) ? [unverifiable] : [];
  const container = containerName(declaration);
  if (Node.isMethodSignature(declaration) && container !== undefined && SCRIPT_LOADERS.get(container) === name) return [unverifiable];
  if (name === "sendBeacon" && container === "Navigator") return [net(args[0])];
  if (name === "open" && container === "XMLHttpRequest") return [net(args[1])];
  if (container === "Process") return processCapabilities(name, args, reach);
  return [];
}

/**
 * What reaching `declaration` with `args` touches: a platform API matched here, or whatever
 * functions.ts finds. `call` is the call itself, when it's a plain call of the function.
 */
export function capabilitiesOf(declaration: Node, args: readonly Node[], adapters: AdapterIndex, reach: Reach = "value", call?: CallLike): Capability[] {
  const platform = platformCapabilities(declaration, args, reach);
  return platform.length > 0 ? platform : declarationCapabilities(declaration, args, adapters, call);
}

/**
 * What constructing a class of `type` touches: one used as a value (`Reflect.construct(WebSocket, ...)`),
 * with no arguments, or one constructed past a cast (`new (window as any).WebSocket(url)`).
 */
export function constructorCapabilities(type: Type, adapters: AdapterIndex, args: readonly Node[] = []): Capability[] {
  const signatures = type.getConstructSignatures();
  // A class with no constructor and no base class has a signature with no declaration.
  for (const declaration of signatureDeclarations(signatures)) {
    const capabilities = capabilitiesOf(declaration, args, adapters, args.length > 0 ? "called" : "value");
    if (capabilities.length > 0) return capabilities;
  }
  for (const signature of signatures) {
    const stream = fsStreamClass(signature.getReturnType());
    if (stream) return fsCapabilities(stream.name, stream.direct ? args : []);
  }
  return [];
}

function processCapabilities(name: string, args: readonly Node[], reach: Reach): Capability[] {
  // A literal name is like importing the module: what's called on the result is checked.
  if (name === "getBuiltinModule") return literalString(args[0]) === undefined ? [unverifiable] : [];
  if (name === "loadEnvFile") {
    const path = reach === "called" ? (args.length === 0 ? "./.env" : literalString(args[0])) : undefined;
    return [path === undefined ? { name: "fs.read", dynamic: true } : { name: "fs.read", arg: path }, { name: "env" }];
  }
  return [];
}

/**
 * The class a constructor or construct signature in a declaration file builds: `WebSocket` for
 * `declare class WebSocket`, `interface WebSocketConstructor`, or `declare var WebSocket: { new(...) }`.
 */
function constructedClass(declaration: Node): string | undefined {
  // Declaration files have no class expressions, so a constructor is in a class declaration.
  if (Node.isConstructorDeclaration(declaration)) return declaration.getParentIfKindOrThrow(SyntaxKind.ClassDeclaration).getName();
  if (!Node.isConstructSignatureDeclaration(declaration)) return undefined;
  // Otherwise the signature is in a type literal: the type of a variable, or of something else.
  const owner = declaration.getParentOrThrow();
  if (Node.isInterfaceDeclaration(owner)) return owner.getName().replace(/Constructor$/, "");
  const holder = owner.getParent();
  return Node.isVariableDeclaration(holder) ? holder.getName() : undefined;
}

/**
 * Where a platform declaration comes from: the TypeScript lib, @types/node, undici-types (the
 * types of Node's web globals), or the project's own declaration files. Undefined for packages.
 */
function platformSource(declaration: Node): "lib" | "node" | "undici" | "project" | undefined {
  const file = declaration.getSourceFile();
  if (!file.isDeclarationFile()) return undefined;
  const filePath = file.getFilePath();
  if (filePath.includes("/node_modules/typescript/lib/")) return "lib";
  if (filePath.includes("/node_modules/@types/node/")) return "node";
  if (filePath.includes("/node_modules/undici-types/")) return "undici";
  return packageOf(declaration) === undefined ? "project" : undefined;
}

/** A global timer, or the same timer reached through `window` or `self`. */
function isTimer(declaration: Node): boolean {
  if ([...TIMERS].some((name) => isGlobalLibFunction(declaration, name))) return true;
  return Node.isMethodSignature(declaration) && containerName(declaration) === "WindowOrWorkerGlobalScope";
}

/**
 * Whether reaching a timer may evaluate a string as code: called with one, or with arguments
 * that can't be read. Where the program has the browser's timers, also called with something
 * that may be a string (`any`, `unknown`, `TimerHandler`), or used as a value that may later be
 * given one. A program with both lib.dom and Node's types may run in a browser, and TypeScript
 * resolves `setTimeout(x as any)` to Node's declaration there, so the program decides, not the
 * declaration a call resolves to. A value given only functions (`promisify(setTimeout)`) runs none.
 */
function timerEvaluates(declaration: Node, args: readonly Node[], reach: Reach): boolean {
  if (reach === "called with unknown arguments") return true;
  if (reach === "called") {
    const first = args[0];
    return evaluatesString(first) || (first !== undefined && hasBrowserTimers(declaration) && admitsString(first.getType(), first));
  }
  return reach === "value" && hasBrowserTimers(declaration);
}

/** Whether the program declares the browser's timers: lib.dom's or a worker's, which may share a name with Node's. */
function hasBrowserTimers(declaration: Node): boolean {
  if (platformSource(declaration) === "lib") return true;
  // Otherwise it's Node's global function or variable (see isTimer), and the symbol of its name
  // is the global one, merged with lib.dom's of the same name.
  const name = declaration.getFirstChildByKindOrThrow(SyntaxKind.Identifier);
  return name.getSymbolOrThrow().getDeclarations().some((d) => platformSource(d) === "lib");
}

function net(arg: Node | undefined): Capability {
  const host = hostOf(arg);
  return host === undefined ? { name: "net", dynamic: true } : { name: "net", arg: host };
}
