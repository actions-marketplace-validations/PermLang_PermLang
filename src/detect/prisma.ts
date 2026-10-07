// Prisma, the first database client with built-in support (design doc open
// question 2). Prisma generates one `<Model>Delegate` interface per model; the
// table in db.read/db.write is the model's accessor name, e.g. `prisma.lead`.
// Related tables reached through `include`, `where`, nested writes, and the fluent
// API (`prisma.user.findUnique(...).posts()`) are read from the arguments
// (prisma-args.ts).
//
// A client built with `$extends(...)` (read replicas, soft deletes, logging) types
// every model through generic runtime types instead, so the declaration doesn't
// name the model. Then the model comes from those types, or from the call site:
// `client.user.findMany`.
//
// A query extension, `$extends({ query: { lead: { findMany({ args, query }) {...} } } })`,
// gets a `query` function that runs the operation it intercepts: a call of it is that
// operation, with the arguments given to it. So is `next(params)` in older clients'
// `$use` middleware, which can run any operation.
//
// Prisma is recognized by its own files, never by a name in a path: a project in a
// folder called prisma-shop isn't Prisma. Its files are the @prisma/client package,
// the client it generates into node_modules/.prisma/client, and a client generated
// into a custom `output` folder, which Prisma marks (isGeneratedClient).

import { Node, SyntaxKind, type CallExpression, type ImportDeclaration, type SourceFile, type Symbol as MorphSymbol, type Type } from "ts-morph";
import { packageOf } from "../adapters.js";
import type { Capability } from "../capability.js";
import { descendantsOfKind } from "../walk.js";
import { accessor, argumentAccess, modelNamed, relationAccess, scoped, type Arguments, type Model } from "./prisma-args.js";
import { argumentsOf, containerName, literalString, unwrapExpression, type CallLike, type CapabilityUse } from "./shared.js";

const READS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "count", "aggregate", "groupBy",
]);
const WRITES = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn",
  "upsert", "delete", "deleteMany",
]);
// Raw queries can touch any table, and a "query" can still write (INSERT ... RETURNING).
const RAW = /^\$(queryRaw|executeRaw|runCommandRaw)/;
// The types that hand a query extension, or `$use` middleware, the function that runs the
// intercepted operation: `query` (or middleware's `next`). See isQueryRunner.
const INTERCEPTED = new Set(["DynamicQueryExtensionCbArgs", "DynamicQueryExtensionArgs", "QueryOptionsCbArgs", "ModelQueryOptionsCbArgs", "Middleware"]);
// Functions an extended client's types give, with no name of their own: an operation, and a
// fluent API step, which only reads.
const OPERATION_TYPES = new Set(["DynamicModelExtensionOperationFn"]);
const FLUENT_TYPES = new Set(["DynamicModelExtensionFluentApi"]);

const raw: Capability[] = [{ name: "db.read", dynamic: true }, { name: "db.write", dynamic: true }];

/** `declaration` is the resolved signature of `call`, which is absent when the function is used as a value. */
export function prismaCapabilities(declaration: Node, call?: CallLike): Capability[] {
  // A query extension's `query` held in a variable or parameter of the project's: passed
  // along as a value, or called through `.call` or `.apply`, it runs any operation.
  if (!isPrismaClient(declaration)) return holdsInterceptedQuery(declaration) ? raw : [];
  const indirect = call !== undefined && isIndirect(call);
  const intercepted = interceptedQuery(declaration, indirect ? undefined : call);
  if (intercepted) return intercepted;
  const method = memberName(declaration) ?? (indirect ? undefined : calledName(call));
  if (!method) return unnamedFunction(declaration);
  const container = containerName(declaration) ?? "";
  // A function used as a value, or called through .call/.apply/.bind, gets arguments that can't be read.
  const args: Arguments = !call || indirect ? "unknown" : argumentsOf(call)[0];
  const near = declaration.getSourceFile();

  const delegate = /^(\w+)Delegate$/.exec(container)?.[1];
  if (delegate) return forModel(method, modelNamed(delegate, near), args);
  if (RAW.test(method)) return raw;
  const fluent = /^Prisma__(\w+)Client$/.exec(container)?.[1];
  if (fluent) return relationAccess(method, args, modelNamed(fluent, near), declaration) ?? [];
  // An extended client's fluent step is a relation in its model's payload: passed along, it
  // could follow that relation with any arguments.
  if (/^\$\w+Payload$/.test(container)) return [{ name: "db.read", dynamic: true }];

  // An extended client: the runtime types, or the call site, name the model.
  const receiver = indirect ? undefined : receiverOf(call);
  const typed = receiver && runtimeModel(receiver.getType(), receiver);
  if (typed?.fluent) return relationAccess(method, args, typed.model, receiver!) ?? [];
  if (typed) return forModel(method, typed.model, args);
  if (READS.has(method) || WRITES.has(method)) return forModel(method, { table: modelAtCallSite(receiver), payload: undefined }, args);
  return [];
}

function forModel(method: string, model: Model, args: Arguments): Capability[] {
  if (READS.has(method)) return [scoped("db.read", model.table), ...argumentAccess(args, model, "read")];
  if (WRITES.has(method)) return [scoped("db.write", model.table), ...argumentAccess(args, model, "write")];
  // Anything else on a model is a raw query: MongoDB's findRaw and aggregateRaw run a
  // filter or pipeline that can name other collections ($lookup, $out), like $runCommandRaw.
  return raw;
}

/**
 * A call of the function a query extension (or `$use` middleware) is given to run the
 * operation it intercepts. Its operation and model come from the object it was taken
 * from, `{ model: "Lead", operation: "findMany", args, query }`; when they can't be read
 * (`$allModels`, `$allOperations`, `query` passed along first), it could run any query.
 * Undefined for anything else.
 */
function interceptedQuery(declaration: Node, call: CallLike | undefined): Capability[] | undefined {
  if (!isQueryRunner(declaration)) return undefined;
  const holder = Node.isCallExpression(call) && Node.isFunctionTypeNode(declaration) ? queryHolder(call) : undefined;
  const literal = (key: string) => {
    const type = holder?.getProperty(key)?.getTypeAtLocation(call!);
    return type?.isStringLiteral() ? String(type.getLiteralValue()) : undefined;
  };
  const model = literal("model");
  const operation = literal("operation");
  if (model === undefined || operation === undefined) return raw;
  // The model's relations are in the generated client, where its argument types are declared.
  const argsType = holder!.getProperty("args")?.getTypeAtLocation(call!);
  const near = argsType?.getAliasSymbol()?.getDeclarations()[0]?.getSourceFile();
  const target = near ? modelNamed(model, near) : { table: accessor(model), payload: undefined };
  return forModel(operation, target, argumentsOf(call!)[0]);
}

/**
 * The object a query extension's `query` was taken from: the parameter destructured in
 * `findMany({ args, query })` (or `{ query: run }`), or `params` in `params.query(...)`.
 */
function queryHolder(call: CallExpression): Type | undefined {
  const callee = unwrapExpression(call.getExpression());
  if (Node.isPropertyAccessExpression(callee)) return callee.getName() === "query" ? unwrapExpression(callee.getExpression()).getType() : undefined;
  const binding = Node.isIdentifier(callee) ? callee.getSymbol()?.getDeclarations()[0] : undefined;
  if (!binding || !Node.isBindingElement(binding)) return undefined;
  if ((binding.getPropertyNameNode()?.getText() ?? binding.getName()) !== "query") return undefined;
  // The pattern's type is the type of what's destructured: a parameter's, or a variable's initializer's.
  return binding.getParentOrThrow().getType();
}

/**
 * The function that runs an intercepted operation, as Prisma's types declare it: `query` in
 * a query extension's arguments, or middleware's `next`, as the function type itself or the
 * member holding it. Not the extension or middleware callback, whose type is in the same place.
 */
function isQueryRunner(declaration: Node): boolean {
  if (!INTERCEPTED.has(containerName(declaration) ?? "")) return false;
  const holder = Node.isFunctionTypeNode(declaration) ? declaration.getParent() : declaration;
  const name = Node.isPropertySignature(holder) || Node.isParameterDeclaration(holder) ? holder.getName() : undefined;
  return (name === "query" || name === "next") && holder!.getType().getCallSignatures().length > 0;
}

/** A variable, parameter, or destructured name of the project's that holds a query extension's `query`. */
function holdsInterceptedQuery(declaration: Node): boolean {
  if (!Node.isBindingElement(declaration) && !Node.isParameterDeclaration(declaration) && !Node.isVariableDeclaration(declaration)) return false;
  return declaration.getType().getCallSignatures().some((s) => {
    const d = s.getDeclaration();
    return d !== undefined && isQueryRunner(d) && isPrismaClient(d);
  });
}

/**
 * A function Prisma's types give with no name of its own, reached where its name can't be
 * read: an extended client's operation passed along or called through an alias, which
 * could be any operation of any model, or a fluent API step, which reads one.
 */
function unnamedFunction(declaration: Node): Capability[] {
  const container = containerName(declaration) ?? "";
  if (FLUENT_TYPES.has(container)) return [{ name: "db.read", dynamic: true }];
  return OPERATION_TYPES.has(container) ? raw : [];
}

/** `f.call(...)`, `f.apply(...)`, `f.bind(...)`, or `Reflect.apply(f, ...)`: a call that isn't of `f` with its own arguments. */
function isIndirect(call: CallLike): boolean {
  const name = calledName(call);
  return name === "call" || name === "apply" || name === "bind";
}

/**
 * A model chosen at run time, `prisma[model].findMany()` or `(prisma as any)[name]`: what's
 * called on it could be any operation of any model, and TypeScript resolves it to no one
 * declaration, so it's charged here. A literal key is an ordinary member (`prisma["lead"]`),
 * and a computed key called directly (`prisma[method]()`) is a computed call (computed.ts).
 */
export function computedModels(sourceFile: SourceFile): { node: Node; uses: CapabilityUse[] }[] {
  const found: { node: Node; uses: CapabilityUse[] }[] = [];
  for (const access of descendantsOfKind(sourceFile, SyntaxKind.ElementAccessExpression)) {
    const key = access.getArgumentExpression();
    // A key with one literal value, by value or by type (`model: "lead"`), names one member.
    if (!key || literalString(key) !== undefined || (key.getType().isStringLiteral() && unwrapExpression(key) === key)) continue;
    const parent = access.getParent();
    if (Node.isCallExpression(parent) && parent.getExpression() === access) continue;
    if (!holdsModels(unwrapExpression(access.getExpression()).getType(), access)) continue;
    const text = access.getText().replace(/\s+/g, " ");
    found.push({ node: access, uses: raw.map((capability) => ({ capability, call: text.length > 70 ? `${text.slice(0, 67)}...` : text, verb: "uses" })) });
  }
  return found;
}

/** A Prisma client: an object whose members include models (a delegate, or an extended client's model). */
function holdsModels(type: Type, at: Node): boolean {
  if (type.isAny() || type.isUnknown() || type.isArray() || type.isTuple() || type.isString()) return false;
  // Most objects indexed with a computed key have nothing to do with Prisma: look at whose
  // types they are before looking at their members' types.
  const fromPrisma = (s: MorphSymbol | undefined) => s?.getDeclarations().some((d) => isPrismaClient(d)) === true;
  const parts = [type, ...(type.isIntersection() ? type.getIntersectionTypes() : [])];
  if (!parts.some((t) => fromPrisma(t.getAliasSymbol()) || fromPrisma(t.getSymbol())) && !type.getProperties().some(fromPrisma)) return false;
  return type.getNonNullableType().getProperties().some((p) => {
    const member = p.getTypeAtLocation(at);
    const named = member.getAliasSymbol() ?? member.getSymbol();
    return named !== undefined && /(Delegate|DynamicModelExtensionThis)$/.test(named.getName()) && named.getDeclarations().some((d) => isPrismaClient(d));
  });
}

/** Whether a declaration belongs to a Prisma client. Prisma's API is all types, so code with a body never does. */
export function isPrismaClient(declaration: Node): boolean {
  if (Node.isArrowFunction(declaration) || Node.isFunctionExpression(declaration)) return false;
  if (Node.isBodyable(declaration) && declaration.hasBody()) return false;
  const pkg = packageOf(declaration);
  return pkg === "@prisma/client" || pkg === ".prisma" || isGeneratedClient(declaration.getSourceFile());
}

// A client generated into a custom `output` folder sits among the project's own
// files, so it is recognized by what Prisma writes: the prisma-client generator
// starts every file with this header, and prisma-client-js imports its runtime as
// `runtime`, from @prisma/client or from the copy it puts next to the client. That
// copy is Prisma's too: `$extends` clients are typed by it.
const GENERATED_HEADER = "/* !!! This is code generated by Prisma. Do not edit directly. !!! */";
const RUNTIME_IMPORT = /^(@prisma\/client|\.)\/runtime\//;
const generated = new WeakMap<SourceFile, boolean>();
const clientJs = new WeakMap<SourceFile, boolean>();

function isGeneratedClient(sourceFile: SourceFile): boolean {
  let known = generated.get(sourceFile);
  if (known === undefined) {
    known = sourceFile.getFullText().trimStart().startsWith(GENERATED_HEADER) || isPrismaClientJsFile(sourceFile);
    generated.set(sourceFile, known);
  }
  return known;
}

/**
 * Whether a file belongs to a client prisma-client-js generated: it imports Prisma's runtime
 * as `runtime`, or it's the runtime a client imports. (Its .d.ts files carry no header.) The
 * folder with its own package.json that it writes such a client into is then Prisma's, as
 * @prisma/client is (unmapped.ts).
 */
export function isPrismaClientJsFile(sourceFile: SourceFile): boolean {
  let known = clientJs.get(sourceFile);
  if (known === undefined) {
    known =
      runtimeImports(sourceFile).length > 0 ||
      sourceFile.getReferencingSourceFiles().some((client) => runtimeImports(client).some((i) => i.getModuleSpecifierSourceFile() === sourceFile));
    clientJs.set(sourceFile, known);
  }
  return known;
}

/** A source file's imports of Prisma's runtime as `runtime`. */
function runtimeImports(sourceFile: SourceFile): ImportDeclaration[] {
  return sourceFile.getImportDeclarations().filter((i) => i.getNamespaceImport()?.getText() === "runtime" && RUNTIME_IMPORT.test(i.getModuleSpecifierValue()));
}

/**
 * The model a runtime type stands for, as `$extends` clients type their models:
 * `DynamicModelExtensionThis<TypeMap, "User", ...>`, or the fluent API's
 * `DynamicModelExtensionFluentApi<TypeMap, "User", ...>`. The type map holds the
 * model's payload, which lists its relations.
 */
function runtimeModel(type: Type, at: Node): { model: Model; fluent: boolean } | undefined {
  for (const t of [type, ...(type.isIntersection() ? type.getIntersectionTypes() : [])]) {
    const alias = t.getAliasSymbol()?.getName();
    if (alias !== "DynamicModelExtensionThis" && alias !== "DynamicModelExtensionFluentApi") continue;
    const [typeMap, model] = t.getAliasTypeArguments() as [Type, Type];
    // After a list relation, the fluent API names no model.
    if (!model.isStringLiteral()) continue;
    const name = String(model.getLiteralValue());
    const member = (of: Type | undefined, key: string) => of?.getProperty(key)?.getTypeAtLocation(at);
    const payload = member(member(member(typeMap, "model"), name), "payload");
    return { model: { table: accessor(name), payload }, fluent: alias === "DynamicModelExtensionFluentApi" };
  }
  return undefined;
}

function memberName(d: Node): string | undefined {
  if (Node.isMethodSignature(d) || Node.isMethodDeclaration(d) || Node.isPropertySignature(d)) return d.getName();
  return undefined;
}

/** `findMany` in `client.user.findMany(...)` or `` client.$queryRaw`...` ``. */
function calledName(call: CallLike | undefined): string | undefined {
  if (!call) return undefined;
  const callee = unwrapExpression(Node.isTaggedTemplateExpression(call) ? call.getTag() : call.getExpression());
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
}

/** `client.user` in `client.user.findMany(...)`. */
function receiverOf(call: CallLike | undefined): Node | undefined {
  if (!call || Node.isTaggedTemplateExpression(call)) return undefined;
  const callee = unwrapExpression(call.getExpression());
  return Node.isPropertyAccessExpression(callee) ? unwrapExpression(callee.getExpression()) : undefined;
}

/** `user` in `client.user.findMany(...)`; undefined when the model is reached another way. */
function modelAtCallSite(receiver: Node | undefined): string | undefined {
  return receiver && Node.isPropertyAccessExpression(receiver) ? receiver.getName() : undefined;
}
