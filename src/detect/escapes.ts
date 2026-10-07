// Capabilities hidden behind `any`: `(globalThis as any).fetch(url)`,
// `(childProcess as any)["exec"]("ls")`, `const m: any = childProcess`.
//
// Once a value is typed `any`, nothing called on it can be resolved. But where it
// becomes `any`, the type checker still knows what it was. So the escape is
// checked there, for two kinds of value:
//
//   - The global objects (`globalThis`, `window`, `self`, `global`, `process`),
//     also reached through one another (`globalThis.process`). A member read
//     straight off a cast is looked up on the original type:
//     `(self as any).fetch(url)` is a fetch call, with its host, and
//     `(process as any).env.KEY` reads env(KEY). Anything else is left alone:
//     these objects are cast to `any` all the time for harmless reasons
//     (`(window as any).dataLayer`, `const w = window as any`). Database clients
//     (a Prisma client or model, a Drizzle database, a SQL pool) are followed the
//     same way: `(prisma as any).lead.deleteMany()` is a Prisma call.
//   - A capability module: any value whose type is one (a namespace or default
//     import, `import cp = require(...)`, the result of `await import(...)` or
//     `process.getBuiltinModule(...)`, or a module of the project's own that
//     re-exports one). Named members are looked up the same way; one that's called
//     or constructed returns `any` too, so a result that reaches a capability
//     (`new (pg as any).Client()`) is unverifiable. Any other escape (a computed
//     member, storing it, passing it on as `any` or `unknown` or to a generic or
//     mapped parameter, copying it with a spread, enumerating it with
//     `Object.values`) loses track of it, and is unverifiable.
//
// A cast through `unknown` to a hand-written type (`x as unknown as { exec(): void }`)
// erases the original type just like `any` does, and is treated the same.
// Capability functions themselves (`fetch as any`) are value uses, handled in values.ts.
//
// Also here: process.binding() and process._linkedBinding(), internal APIs the
// types don't declare, which reach Node's native internals (spawning processes, say).

import {
  Node,
  SyntaxKind,
  ts,
  type CallExpression,
  type ElementAccessExpression,
  type Identifier,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  type SourceFile,
  type Symbol as MorphSymbol,
  type Type,
} from "ts-morph";
import type { AdapterIndex } from "../adapters.js";
import { UNVERIFIABLE, type Capability } from "../capability.js";
import { isDatabaseObject, requiresCapabilityModule } from "./functions.js";
import { argumentsOf, callText, containerName, literalString, resolveAlias, resolvedDeclaration, signatureDeclarations, unwrapExpression, type CapabilityUse } from "./shared.js";
import { capabilitiesOf, constructorCapabilities } from "./web.js";
import { forEachDescendant } from "../walk.js";

export interface EscapeUse {
  node: Node;
  uses: CapabilityUse[];
}

/** Globals whose members include capabilities. */
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global", "process"]);
/** Internal process APIs that the types don't declare. (Undefined stands for a computed name.) */
const PROCESS_INTERNALS = new Set<string | undefined>(["binding", "_linkedBinding"]);
/**
 * Object functions that list an object's members, functions included, and keep their own type
 * for it. (Object.keys, Reflect.ownKeys, and the like take `object` or `any`, so passing a module
 * to them already loses its type.)
 */
const ENUMERATORS = new Set(["values", "entries", "getOwnPropertyDescriptors"]);

type Carrier = "global" | "module";

export function anyEscapes(sourceFile: SourceFile, adapters: AdapterIndex): EscapeUse[] {
  const out: EscapeUse[] = [];
  const carriers = new CarrierCache(adapters);
  forEachDescendant(sourceFile, (node) => {
    if (Node.isAsExpression(node) || Node.isTypeAssertion(node)) {
      // In `x as unknown as T`, the outer cast is the one that matters.
      if (Node.isAsExpression(outerOf(node).getParent()) || Node.isTypeAssertion(outerOf(node).getParent())) return;
      if (!erasesType(node.getType()) && !castsThroughUnknown(node)) return;
      const value = unwrapExpression(node);
      const carrier = carriers.of(value);
      if (!carrier) return;
      const member = memberUse(node, value, carrier, adapters);
      if (member) out.push(member);
      else if (member === undefined && carrier === "module") out.push(hidden(value));
      return;
    }
    if (Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node)) {
      const internal = processInternal(node);
      if (internal) out.push(internal);
      // `fs[name]` read with a computed key, rather than called (calls are in computed.ts).
      else if (Node.isElementAccessExpression(node) && isComputedModuleRead(node, carriers)) out.push(hidden(node, "read with a computed key"));
    }
    // `import cp from "node:child_process"` where the compiler options give the module no default
    // export (allowSyntheticDefaultImports off, as with module commonjs and no esModuleInterop):
    // TypeScript types `cp` as `any`, but bundlers and Node's own interop still hand over the
    // module. A named member is looked up on the module; any other use loses track of it.
    else if (Node.isIdentifier(node) && carriers.untypedDefault(node)) {
      const use = untypedDefaultUse(node, carriers.untypedDefault(node)!, adapters);
      if (use) out.push(use);
    }
    // A capability module used where its type is lost: `const m: any = cp`, `m = cp` with
    // `let m: any`, `use(cp)` with `function use(m: unknown)` (or `<T>(m: T)`), `run.call(cp)`,
    // `Object.values(cp)`, or `{ ...cp }`.
    else if (Node.isIdentifier(node) && isPassedOn(node) && carriers.of(node) === "module") {
      const receiver = thisReceiver(node);
      const lost = receiver ? undefined : typeLostBy(node) ?? genericParameterType(node);
      if (receiver === "project") out.push(hidden(node, "given as `this`"));
      else if (lost) out.push(hidden(node, lost.isAny() ? "cast to `any`" : `passed on as \`${lost.getText()}\``));
      else if (isEnumerated(node)) out.push(hidden(node, "with its members listed"));
      else if (Node.isSpreadAssignment(node.getParent())) out.push(hidden(node, "copied with a spread"));
    }
    // `Reflect.get(cp, name)`, the same as `cp[name]`.
    else if (Node.isCallExpression(node) && isComputedReflectGet(node, carriers)) out.push(hidden(node, "read with a computed key"));
    // `.then((m: any) => m.exec("ls"))` on a promise of a capability module.
    else if (Node.isParameterDeclaration(node) && receivesModuleAsAny(node, carriers)) out.push(hidden(node, "given a capability module"));
  });
  return out;
}

/** The outermost node of `node` wrapped in parentheses. */
function outerOf(node: Node): Node {
  let outer = node;
  while (Node.isParenthesizedExpression(outer.getParent())) outer = outer.getParentOrThrow();
  return outer;
}

/** `any`, or a record whose values are `any`: members read through it can't be resolved. */
function erasesType(type: Type): boolean {
  if (type.isAny()) return true;
  return type.getStringIndexType()?.isAny() === true || type.getNumberIndexType()?.isAny() === true;
}

/**
 * A type a module can be passed as but not used through: `any`, `unknown`, `object`, `{}`, or a
 * record such as `Record<string, unknown>`, also when optional.
 */
function losesModule(contextual: Type): boolean {
  const type = contextual.getNonNullableType();
  if (type.isAny() || type.isUnknown() || type.getText() === "object") return true;
  return type.isObject() && type.getProperties().length === 0 && type.getCallSignatures().length === 0;
}

/** `x as unknown as T`: the second cast replaces the original type with one the code wrote itself. */
function castsThroughUnknown(cast: Node): boolean {
  if (!Node.isAsExpression(cast) && !Node.isTypeAssertion(cast)) return false;
  let inner = cast.getExpression();
  while (Node.isParenthesizedExpression(inner)) inner = inner.getExpression();
  return (Node.isAsExpression(inner) || Node.isTypeAssertion(inner)) && (inner.getType().isUnknown() || inner.getType().isAny());
}

/** Which values carry capabilities: the global objects, and capability modules (by import, or by type). */
class CarrierCache {
  private readonly moduleTypes = new Map<MorphSymbol, boolean>();

  constructor(private readonly adapters: AdapterIndex) {}

  of(value: Node): Carrier | undefined {
    if (isGlobalObject(value)) return "global";
    // A database client is followed like a global object: by the members read off a cast.
    if ((Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) && isDatabaseObject(value.getType())) return "global";
    if (Node.isIdentifier(value) && this.importsCapabilityModule(value)) return "module";
    // Literals, `this`, and the like are never modules; only look at the type of a name or an expression that can hold one.
    const holds = Node.isIdentifier(value) || Node.isPropertyAccessExpression(value) || Node.isAwaitExpression(value) || Node.isCallExpression(value);
    return holds && this.isCapabilityModule(value.getType(), value) ? "module" : undefined;
  }

  /**
   * For a reference to a default import of a capability module that TypeScript types as `any`
   * (the module has no default export under the compiler options), the module's own type.
   */
  untypedDefault(id: Identifier): Type | undefined {
    const parent = id.getParent();
    // `export { cp }` names the export; the import it hands on is its local target.
    const symbol = Node.isExportSpecifier(parent) && parent.getNameNode() === id ? parent.getLocalTargetSymbol() : id.getSymbol();
    const clause = symbol?.getDeclarations().find((d) => Node.isImportClause(d));
    if (!clause || !Node.isImportClause(clause) || clause.getDefaultImport()?.getType().isAny() !== true) return undefined;
    const declaration = clause.getParentIfKindOrThrow(SyntaxKind.ImportDeclaration);
    if (!this.isCapabilityModuleName(declaration.getModuleSpecifierValue())) return undefined;
    // A module that doesn't resolve at all is an import with no types (PERM007, unmapped.ts).
    return declaration.getModuleSpecifier().getSymbol()?.getTypeAtLocation(declaration);
  }

  /** A namespace or default import of a capability module: `import fs from "node:fs"`, `import cluster from "node:cluster"`. */
  private importsCapabilityModule(value: Node): boolean {
    for (const d of value.getSymbol()?.getDeclarations() ?? []) {
      if (!Node.isNamespaceImport(d) && !Node.isImportClause(d)) continue;
      const specifier = d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
      if (specifier !== undefined && this.isCapabilityModuleName(specifier)) return true;
    }
    return false;
  }

  /** A module's namespace type: a Node built-in or package with capabilities, or a module of the project's that re-exports one. */
  isCapabilityModule(type: Type, at: Node, depth = 0): boolean {
    const symbol = type.getSymbol();
    if (!symbol || depth > 3) return false;
    // `await import("node:fs")` in CommonJS: an anonymous copy of the module's members, plus `default`.
    if (symbol.getDeclarations().length === 0) {
      const fallback = type.getProperty("default");
      return fallback !== undefined && this.isCapabilityModule(fallback.getTypeAtLocation(at), at, depth + 1);
    }
    const known = this.moduleTypes.get(symbol);
    if (known !== undefined) return known;
    this.moduleTypes.set(symbol, false); // a module that re-exports itself
    let result = false;
    for (const d of symbol.getDeclarations()) {
      if (Node.isModuleDeclaration(d) && Node.isStringLiteral(d.getNameNode())) {
        result ||= this.isCapabilityModuleName(d.getNameNode().getText().slice(1, -1));
      } else if (Node.isSourceFile(d)) {
        result ||= this.exportsCapabilities(type, d, depth);
      }
    }
    this.moduleTypes.set(symbol, result);
    return result;
  }

  private isCapabilityModuleName(specifier: string): boolean {
    return isCapabilityModuleName(specifier, this.adapters);
  }

  /** Whether a module file exports a capability function, or a capability module (`export * as cp from "node:child_process"`). */
  private exportsCapabilities(type: Type, file: SourceFile, depth: number): boolean {
    for (const exported of type.getProperties()) {
      for (const declaration of resolveAlias(exported).getDeclarations()) {
        if (capabilitiesOf(declaration, [], this.adapters).length > 0) return true;
      }
      if (this.isCapabilityModule(exported.getTypeAtLocation(file), file, depth + 1)) return true;
    }
    return false;
  }
}

/** `globalThis`, `window`, `self`, `global`, or `process` from the standard library, also reached through one another (`globalThis.process`). */
function isGlobalObject(value: Node): boolean {
  if (Node.isPropertyAccessExpression(value)) {
    return GLOBAL_OBJECTS.has(value.getName()) && isGlobalObject(unwrapExpression(value.getExpression()));
  }
  if (!Node.isIdentifier(value) || !GLOBAL_OBJECTS.has(value.getText())) return false;
  const symbol = value.getSymbol();
  if (!symbol) return false;
  const declarations = symbol.getDeclarations();
  // `globalThis` is built into the checker and has no declaration; the others come from lib files.
  return declarations.length === 0 ? symbol.getName() === "globalThis" : declarations.every((d) => d.getSourceFile().isDeclarationFile());
}

/** A reference that hands the value on whole: an argument, assignment, or initializer, not a member access or a declaration. */
function isPassedOn(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (!parent || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) return false;
  // `cp as any` is the cast case above; `cp.exec`, `cp["exec"]` are normal calls.
  if (Node.isAsExpression(parent) || Node.isTypeAssertion(parent) || Node.isParenthesizedExpression(parent) || Node.isSatisfiesExpression(parent)) return false;
  if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === identifier) return false;
  if ("getNameNode" in parent && (parent as { getNameNode(): Node }).getNameNode() === identifier) return false;
  return Node.isExpression(identifier) && !identifier.getFirstAncestor((a) => Node.isTypeNode(a));
}

/**
 * The contextual type that loses a module passed where it's expected: an argument, assignment,
 * or initializer typed `any`, `unknown`, `object`, and the like (see losesModule). Undefined
 * when the module keeps its type.
 */
function typeLostBy(identifier: Identifier): Type | undefined {
  const contextual = identifier.getContextualType();
  return contextual !== undefined && losesModule(contextual) ? contextual : undefined;
}

/**
 * The declared type of a project function's parameter that takes a module under a type of its
 * own: a type parameter (`<T>(m: T)`), or a mapped type (`Partial<typeof cp>`, `Pick<...>`).
 * The argument's contextual type is the module's, but inside the function the module is a `T`,
 * which a cast loses (`(m as any).exec(cmd)`). Library functions are trusted, as everywhere.
 */
function genericParameterType(identifier: Identifier): Type | undefined {
  const call = identifier.getParent();
  if (!Node.isCallExpression(call) && !Node.isNewExpression(call)) return undefined;
  const index = call.getArguments().indexOf(identifier);
  const declaration = index < 0 ? undefined : resolvedDeclaration(call);
  if (!declaration || declaration.getSourceFile().isDeclarationFile() || !("getParameters" in declaration)) return undefined;
  const parameters = (declaration as { getParameters(): ParameterDeclaration[] }).getParameters();
  // Past the last parameter, an argument is the rest parameter's. (With none, its contextual type
  // is `any`, which typeLostBy reports before this is asked.)
  const parameter = parameters[Math.min(index, parameters.length - 1)]!;
  const declared = parameter.getType();
  // A rest parameter passes its elements, or is a type parameter itself (`...args: T`).
  const type = parameter.isRestParameter() ? declared.getArrayElementType() ?? declared : declared;
  // An optional parameter's type is a union with `undefined`.
  const generic = (t: Type) => t.isTypeParameter() || (t.getObjectFlags() & ts.ObjectFlags.Mapped) !== 0;
  return (type.isUnion() ? type.getUnionTypes() : [type]).some(generic) ? type : undefined;
}

/**
 * Whose function a module is given to as `this`, by `.call`, `.apply`, or `.bind`: a library's
 * (`fs.readFile.bind(fs)`), trusted like library code everywhere, or the project's own (or one
 * that can't be resolved), which could use `this` as anything, whatever the contextual type
 * says (`.call` infers it from the module). Undefined when the module isn't given as `this`.
 */
function thisReceiver(identifier: Node): "library" | "project" | undefined {
  const call = identifier.getParent();
  if (!Node.isCallExpression(call) || call.getArguments()[0] !== identifier) return undefined;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || !/^(call|apply|bind)$/.test(callee.getName())) return undefined;
  const declarations = callee.getExpression().getSymbol()?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every((d) => d.getSourceFile().isDeclarationFile()) ? "library" : "project";
}

/** `Object.values(cp)`, `Object.entries(cp)`: its functions, listed without their names' types. */
function isEnumerated(identifier: Node): boolean {
  const call = identifier.getParent();
  if (!Node.isCallExpression(call) || call.getArguments()[0] !== identifier) return false;
  const declaration = resolvedDeclaration(call);
  return Node.isMethodSignature(declaration) && containerName(declaration) === "ObjectConstructor" && ENUMERATORS.has(declaration.getName());
}

/** `fs[name]` with a key that isn't a literal, read or written rather than called (calls are in computed.ts). */
function isComputedModuleRead(access: ElementAccessExpression, carriers: CarrierCache): boolean {
  if (literalString(access.getArgumentExpression()) !== undefined) return false;
  const parent = access.getParent();
  if (Node.isCallExpression(parent) && parent.getExpression() === access) return false;
  return carriers.of(unwrapExpression(access.getExpression())) === "module";
}

/** `Reflect.get(cp, name)` with a computed name; on a global, only when what it reads is then called or read from. */
function isComputedReflectGet(call: CallExpression, carriers: CarrierCache): boolean {
  if (call.getExpression().getText() !== "Reflect.get") return false;
  const [target, key] = call.getArguments();
  if (!target || literalString(key) !== undefined) return false;
  const carrier = carriers.of(unwrapExpression(target));
  if (carrier === "module") return true;
  const outer = outerOf(call);
  const parent = outer.getParent();
  const used = Node.isCallExpression(parent) ? parent.getExpression() === outer : Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent);
  return carrier === "global" && used;
}

/** `(m: any) => m.exec("ls")` where the callback is given a capability module. */
function receivesModuleAsAny(parameter: ParameterDeclaration, carriers: CarrierCache): boolean {
  const written = parameter.getTypeNode()?.getKind();
  if (written !== SyntaxKind.AnyKeyword && written !== SyntaxKind.UnknownKeyword) return false;
  const fn = parameter.getParent();
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return false;
  // The callback's contextual type may allow null or undefined too (`then(onfulfilled?)`).
  const signature = fn.getContextualType()?.getNonNullableType().getCallSignatures()[0];
  const given = signature?.getParameters()[fn.getParameters().indexOf(parameter)];
  return given !== undefined && carriers.isCapabilityModule(given.getTypeAtLocation(fn), fn);
}

/** `process.binding("spawn_sync")`, `(process as any)._linkedBinding(...)`, `globalThis.process["binding"]`. */
function processInternal(access: PropertyAccessExpression | ElementAccessExpression): EscapeUse | undefined {
  const name = Node.isPropertyAccessExpression(access) ? access.getName() : literalString(access.getArgumentExpression());
  if (!PROCESS_INTERNALS.has(name)) return undefined;
  const object = unwrapExpression(access.getExpression());
  const holder = Node.isPropertyAccessExpression(object) ? object.getName() : object.getText();
  if (holder !== "process" || !isGlobalObject(object)) return undefined;
  return { node: access, uses: [{ capability: unverifiable, call: access.getText().replace(/\s+/g, " "), verb: "uses" }] };
}

/**
 * `(x as any).name(...)` or `(x as any)["name"]`: the member as the original type declares it,
 * following a chain of named members (`(window as any).navigator.sendBeacon(url)`).
 * Returns null for a member that isn't a capability, and undefined when the use isn't a single
 * named member (a module's escape is then reported as hidden).
 */
function memberUse(cast: Node, value: Node, carrier: Carrier, adapters: AdapterIndex, original = value.getType()): EscapeUse | null | undefined {
  let object: Node = outerOf(cast);
  let type = original;
  let name: string | undefined;
  for (let depth = 0; depth < 8; depth++) {
    const access = object.getParent();
    if (Node.isPropertyAccessExpression(access) && access.getExpression() === object) name = access.getName();
    else if (Node.isElementAccessExpression(access) && access.getExpression() === object) {
      name = literalString(access.getArgumentExpression());
      // A computed member. On a global, reading one (`(window as any)[key]`) is how apps read config;
      // calling one is already unverifiable as a computed call (detect/computed.ts).
      if (name === undefined) return carrier === "module" ? hidden(value) : null;
    } else if (depth === 0) return undefined;
    else break;

    // Replacing a member (`(globalThis as any).fetch = mock`) isn't using it.
    const write = access.getParent();
    if (Node.isBinaryExpression(write) && write.getLeft() === access && write.getOperatorToken().getKind() === SyntaxKind.EqualsToken) return null;

    const property = type.getProperty(name);
    // The original type has no such member. On a global it isn't one of its capabilities; on a
    // capability module it could be an API newer than its types (`(fs as any).someNewWrite()`).
    if (!property) return carrier === "module" ? hidden(value) : null;

    // `(globalThis as any).process.mainModule.require(...)`: an optional member's members are still there.
    type = property.getTypeAtLocation(access).getNonNullableType();
    const used = propertyUse(property, type, access, adapters) ?? (carrier === "module" ? returnedUse(type, access, adapters) : undefined);
    if (used) return used;
    object = access;
  }
  // The chain ends on a member that isn't a capability, used some other way (stored, passed on).
  // One that is itself a global object (`(globalThis as any).process`) could reach anything; so
  // could a namespace-like member of a capability module (`(fs as any).promises`).
  if (name !== undefined && GLOBAL_OBJECTS.has(name)) return hidden(value);
  return carrier === "module" && isModuleObject(type, adapters) ? hidden(value) : null;
}

/**
 * A use of a default import TypeScript types as `any` (see CarrierCache.untypedDefault), with
 * `module` its module's type: a named member as the module declares it (`cp.execSync(...)`), or
 * hidden for any other use (destructured, passed on, exported). The import itself, a type
 * position, and a cast (checked as one) aren't uses.
 */
function untypedDefaultUse(id: Identifier, module: Type, adapters: AdapterIndex): EscapeUse | undefined {
  const parent = outerOf(id).getParent();
  if (Node.isImportClause(id.getParent()) || id.getFirstAncestor((a) => Node.isTypeNode(a) || Node.isJSDoc(a))) return undefined;
  if (Node.isAsExpression(parent) || Node.isTypeAssertion(parent) || Node.isSatisfiesExpression(parent)) return undefined;
  const member = memberUse(id, id, "module", adapters, module);
  if (member !== undefined) return member ?? undefined;
  return hidden(id, "imported as a default export the module doesn't have under these compiler options");
}

/** What reading, calling, or constructing one member read past a cast, of type `type`, touches, if anything. */
function propertyUse(property: MorphSymbol, type: Type, access: Node, adapters: AdapterIndex): EscapeUse | undefined {
  const env = envUse(type, access);
  if (env) return env;
  // A member that isn't a function or class (`(fs as any).constants`) is no capability itself.
  if (type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0) return undefined;
  const parent = access.getParent();
  const call = (Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === access ? parent : undefined;
  const use = (capabilities: Capability[]): EscapeUse | undefined => {
    if (capabilities.length === 0) return undefined;
    const text = call ? callText(call) : `${access.getText().replace(/\s+/g, " ")} as a value`;
    return { node: call ?? access, uses: capabilities.map((capability) => ({ capability, call: text, verb: call ? "calls" : "uses" })) };
  };
  const args = call ? argumentsOf(call) : [];
  if (Node.isNewExpression(call)) return use(constructorCapabilities(type, adapters, args));
  for (const declaration of resolveAlias(property).getDeclarations()) {
    const found = use(capabilitiesOf(declaration, args, adapters, call ? "called" : "value", call));
    if (found) return found;
  }
  // `(process as any).getBuiltinModule("child_process")` returns the module as `any`. (A computed
  // name, and the function used as a value, are unverifiable above, so this is a call with a literal name.)
  if (property.getName() === "getBuiltinModule" && isCapabilityModuleName(literalString(args[0])!, adapters)) {
    return hidden(call!, "returned as `any`");
  }
  return undefined;
}

/**
 * A capability module's function or class, called or constructed past a cast, whose result
 * reaches a capability: that result is `any` too, so nothing called on it can be checked
 * (`new (pg as any).Client().query(sql)`, `(module as any).createRequire(file)(name)`).
 */
function returnedUse(type: Type, access: Node, adapters: AdapterIndex): EscapeUse | undefined {
  const call = access.getParent();
  if ((!Node.isCallExpression(call) && !Node.isNewExpression(call)) || call.getExpression() !== access) return undefined;
  const signatures = Node.isNewExpression(call) ? type.getConstructSignatures() : type.getCallSignatures();
  const reaches = signatures.some((s) => carriesCapabilities(awaited(s.getReturnType()), adapters));
  return reaches ? hidden(call, "returned as `any`") : undefined;
}

/** What a promise resolves to, or the type itself. */
function awaited(type: Type): Type {
  const isPromise = type.getSymbol()?.getName() === "Promise" && type.getSymbol()!.getDeclarations().some((d) => d.getSourceFile().isDeclarationFile());
  return (isPromise ? type.getTypeArguments()[0] : undefined) ?? type;
}

/** Whether calling a value of `type`, or one of its methods, reaches a capability. */
function carriesCapabilities(type: Type, adapters: AdapterIndex): boolean {
  const reaches = (declaration: Node) => capabilitiesOf(declaration, [], adapters).length > 0;
  if (signatureDeclarations(type.getCallSignatures()).some(reaches)) return true;
  return type.getProperties().some((p) => resolveAlias(p).getDeclarations().some(reaches));
}

/** `(process as any).env.KEY`, `(process as any).env`: the environment, read past the cast. */
function envUse(type: Type, access: Node): EscapeUse | undefined {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (symbol?.getName() !== "ProcessEnv" || !symbol.getDeclarations().some((d) => d.getSourceFile().isDeclarationFile())) return undefined;
  const parent = access.getParent();
  const key =
    parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === access
      ? parent.getName()
      : parent && Node.isElementAccessExpression(parent) && parent.getExpression() === access
        ? literalString(parent.getArgumentExpression())
        : undefined;
  const site = key !== undefined && parent ? parent : access;
  const capability: Capability = key !== undefined ? { name: "env", arg: key } : { name: "env" };
  return { node: site, uses: [{ capability, call: site.getText().replace(/\s+/g, " "), verb: "reads" }] };
}

/** A Node built-in or package with capabilities, and not declared pure. */
function isCapabilityModuleName(specifier: string, adapters: AdapterIndex): boolean {
  return requiresCapabilityModule(specifier, adapters) && !adapters.isPure(specifier.replace(/^node:/, ""));
}

/** A namespace-like member of a capability module (`fs.promises`): its own members carry capabilities. */
function isModuleObject(type: Type, adapters: AdapterIndex): boolean {
  if (type.getCallSignatures().length > 0) return false;
  for (const d of type.getSymbol()?.getDeclarations() ?? []) {
    for (const m of [d, ...d.getAncestors()]) {
      if (!Node.isModuleDeclaration(m)) continue;
      const name = m.getNameNode();
      if (Node.isStringLiteral(name) && requiresCapabilityModule(name.getLiteralValue(), adapters)) return true;
    }
  }
  return false;
}

const unverifiable: Capability = { name: UNVERIFIABLE };

function hidden(value: Node, how = "cast to `any`"): EscapeUse {
  const text = value.getText().replace(/\s+/g, " ");
  const shown = text.length > 70 ? `${text.slice(0, 67)}...` : text;
  return { node: value, uses: [{ capability: unverifiable, call: `${shown} ${how}`, verb: "uses" }] };
}
