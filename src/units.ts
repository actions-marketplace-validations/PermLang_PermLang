// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The PermLang Authors

// Units are the things permissions attach to: named functions, methods,
// constructors, accessors, function-valued variables and properties, and each
// file's top-level code. Anonymous callbacks belong to the unit around them.

import { Node, SyntaxKind, ts, type ClassDeclaration, type ClassExpression, type ModuleDeclaration, type ObjectLiteralExpression, type SourceFile, type Symbol as MorphSymbol } from "ts-morph";
import { functionComments, jsDocComments, moduleComments, readPermAnnotation, type Comment, type PermAnnotation } from "./annotations.js";
import { UNVERIFIABLE, type Capability } from "./capability.js";
import { resolveAlias, unwrapExpression, type CallLike } from "./detect/shared.js";
import { descendantsOfKind, lineAndColumn } from "./walk.js";

export interface Use {
  verb: "calls" | "reads" | "uses";
  capability: Capability;
  call: string;
  line: number;
  column: number;
}

export interface Unit {
  node: Node;
  file: string;
  name: string;
  line: number;
  /** Exported, or top-level code (which runs on import). */
  exported: boolean;
  /** The unit's own @perm tags. */
  own: PermAnnotation | undefined;
  /** The file's @module @perm tags, shared by every unit in the file. */
  module: PermAnnotation | undefined;
  /** Capabilities used directly in the unit's body. */
  uses: Use[];
  /**
   * Declared in one of the project's own .d.ts files, for JavaScript the checker doesn't
   * analyze, so it's unverifiable. Calls reach it, but it isn't reported or locked itself.
   */
  declarationOnly?: true;
  /**
   * For an anonymous function a call can reach through its type (dispatch.ts): the unit
   * whose code it is. It stands for the part of that unit inside it, and isn't reported
   * or locked itself.
   */
  around?: Unit;
}

export function isAnnotated(unit: Unit): boolean {
  return unit.own !== undefined || unit.module !== undefined;
}

export function declaredCapabilities(unit: Unit): Capability[] {
  return [...(unit.module?.capabilities ?? []), ...(unit.own?.capabilities ?? [])];
}

export function readModuleAnnotation(sourceFile: SourceFile, vocabulary: ReadonlySet<string>): PermAnnotation | undefined {
  return readPermAnnotation(moduleComments(sourceFile), sourceFile, vocabulary);
}

export function createUnit(
  node: Node,
  module: PermAnnotation | undefined,
  exports: ReadonlySet<Node>,
  vocabulary: ReadonlySet<string>,
  comments: readonly Comment[] = annotationComments(node),
): Unit {
  const sourceFile = node.getSourceFile();
  return {
    node,
    file: sourceFile.getFilePath(),
    name: unitName(node),
    line: Node.isSourceFile(node) ? 1 : lineAndColumn(sourceFile, node.getStart()).line,
    exported: isExported(node, exports),
    own: Node.isSourceFile(node) ? undefined : readPermAnnotation(comments, sourceFile, vocabulary),
    module,
    uses: [],
  };
}

/** The JSDoc comments a unit's own @perm is read from (a file's are its @module comments). */
export function annotationComments(node: Node): Comment[] {
  return Node.isSourceFile(node) ? [] : functionComments(jsDocsOf(node));
}

// --- which nodes are units ---------------------------------------------------

export function isUnitNode(node: Node): boolean {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isConstructorDeclaration(node)) {
    return node.hasBody(); // overload signatures are not units
  }
  // A class with no constructor has an implicit one: it runs field initializers and the base constructor.
  if (isClass(node)) return !hasExplicitConstructor(node);
  return (
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    isFunctionLike(heldValue(node))
  );
}

/**
 * Declarations that name a function value: `const f = () => ...`, `{ f: () => ... }`,
 * `class { f = () => ... }`, `export default () => ...`.
 */
function isFunctionHolder(node: Node) {
  return Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node) || Node.isExportAssignment(node);
}

/** What a function holder holds; undefined for anything else. */
function heldValue(node: Node): Node | undefined {
  if (Node.isExportAssignment(node)) return node.getExpression();
  if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node)) return node.getInitializer();
  return undefined;
}

function isFunctionLike(node: Node | undefined): boolean {
  return node !== undefined && (Node.isArrowFunction(node) || Node.isFunctionExpression(node));
}

function isClass(node: Node): node is ClassDeclaration | ClassExpression {
  return Node.isClassDeclaration(node) || Node.isClassExpression(node);
}

function hasExplicitConstructor(cls: ClassDeclaration | ClassExpression): boolean {
  return cls.getConstructors().some((c) => c.hasBody());
}

/** The unit for a class's constructor: the explicit one, or the class itself as its implicit constructor. */
export function constructorUnitNode(cls: ClassDeclaration | ClassExpression): Node {
  return cls.getConstructors().find((c) => c.hasBody()) ?? cls;
}

/**
 * The unit a node's code runs in: its nearest named function, else the file.
 * Instance field initializers run in the constructor; static ones and class
 * bodies run where the class is defined.
 */
export function enclosingUnitNode(node: Node): Node {
  for (const ancestor of node.getAncestors()) {
    const parent = ancestor.getParent();
    if (isFunctionLike(ancestor) && parent && isFunctionHolder(parent)) return parent;
    if (Node.isPropertyDeclaration(ancestor) && !ancestor.isStatic() && parent && isClass(parent)) {
      return constructorUnitNode(parent);
    }
    if (isClass(ancestor)) continue;
    if (isUnitNode(ancestor) || Node.isSourceFile(ancestor)) return ancestor;
  }
  return node.getSourceFile();
}

/**
 * The unit a symbol refers to, if it is first-party code: resolves overloads to
 * their implementation and classes to their constructor. Undefined for anything
 * declared in a .d.ts or node_modules (third-party code is M3's adapters).
 */
export function unitNodeForSymbol(symbol: MorphSymbol): Node | undefined {
  for (const declaration of symbol.getDeclarations()) {
    const node = unitNodeForDeclaration(declaration);
    if (node) return node;
  }
  return undefined;
}

/** Every unit a symbol refers to: a property with both a getter and a setter has two. */
export function unitNodesForSymbol(symbol: MorphSymbol): Node[] {
  return [...new Set(symbol.getDeclarations().map(unitNodeForDeclaration).filter((n): n is Node => n !== undefined))];
}

export function unitNodeForDeclaration(d: Node): Node | undefined {
  const sf = d.getSourceFile();
  if (isInNodeModules(sf)) return undefined;
  if (sf.isDeclarationFile()) return declaredUnitNode(d);
  if ((Node.isFunctionDeclaration(d) || Node.isMethodDeclaration(d)) && !d.hasBody()) return d.getImplementation();
  if (isClass(d)) return constructorUnitNode(d);
  if (isUnitNode(d)) return d;
  const parent = d.getParent();
  if (isFunctionLike(d) && parent && isFunctionHolder(parent)) return parent;
  return undefined;
}

const inNodeModules = new WeakMap<SourceFile, boolean>();

export function isInNodeModules(sf: SourceFile): boolean {
  let known = inNodeModules.get(sf);
  if (known === undefined) inNodeModules.set(sf, (known = sf.getFilePath().split("/").includes("node_modules")));
  return known;
}

// --- JavaScript declared in the project's own .d.ts files -------------------

/**
 * The unit a value declared in a .d.ts module stands for: a function (all of its
 * overloads), a class's constructor (the class), a class member, or a variable
 * (including everything in its type). Members of interfaces and type aliases have none:
 * they're types, whose implementations dispatch finds. Ambient declarations
 * (`declare module "x"`, `declare global`, or a .d.ts with no imports or exports)
 * describe packages and what the runtime provides, not the project's code.
 */
function declaredUnitNode(d: Node): Node | undefined {
  if (!ts.isExternalModule(d.getSourceFile().compilerNode)) return undefined;
  const chain = [d, ...d.getAncestors()];
  if (chain.some((n) => Node.isModuleDeclaration(n) && (Node.isStringLiteral(n.getNameNode()) || n.getName() === "global"))) return undefined;
  const holder = chain.find(
    (n) =>
      Node.isFunctionDeclaration(n) || Node.isVariableDeclaration(n) || Node.isClassDeclaration(n) || Node.isConstructorDeclaration(n) ||
      Node.isMethodDeclaration(n) || Node.isPropertyDeclaration(n) || Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n),
  );
  if (!holder) return undefined;
  if (Node.isConstructorDeclaration(holder)) return holder.getParent();
  // Overloads are one unit: the first declaration of the same kind.
  return holder.getSymbol()?.getDeclarations().find((x) => x.getKind() === holder.getKind()) ?? holder;
}

/** A unit for JavaScript declared in a .d.ts: reaching it is unverifiable. */
export function createDeclaredUnit(node: Node): Unit {
  const sourceFile = node.getSourceFile();
  const { line, column } = lineAndColumn(sourceFile, node.getStart());
  const call = `JavaScript declared in ${sourceFile.getBaseName()}`;
  return {
    node,
    file: sourceFile.getFilePath(),
    name: unitName(node),
    line,
    exported: false,
    own: undefined,
    module: undefined,
    uses: [{ verb: "calls", capability: { name: UNVERIFIABLE }, call, line, column }],
    declarationOnly: true,
  };
}

// --- anonymous functions reached through their type ---------------------------

/**
 * A unit for an anonymous function that a call reaches through its type, such as a function
 * kept in a Map (dispatch.ts). Its code belongs to the unit around it, which is charged with
 * it as before; this one has that unit's uses inside the function (check.ts adds its calls).
 * A @perm-unsafe on the unit around it covers it too.
 */
export function createAnonymousUnit(fn: Node, around: Unit): Unit {
  const sourceFile = fn.getSourceFile();
  const { line } = lineAndColumn(sourceFile, fn.getStart());
  const inside = isInside(fn);
  return {
    node: fn,
    file: around.file,
    name: `<function at ${sourceFile.getBaseName()}:${line}>`,
    line,
    exported: false,
    own: around.own,
    module: around.module,
    uses: around.uses.filter(inside),
    around,
  };
}

/** Whether a position (a use's, or a call's) is inside `node`. */
export function isInside(node: Node): (position: { line: number; column: number }) => boolean {
  const sourceFile = node.getSourceFile();
  const start = lineAndColumn(sourceFile, node.getStart());
  const end = lineAndColumn(sourceFile, node.getEnd());
  const after = (p: { line: number; column: number }, q: { line: number; column: number }) => p.line > q.line || (p.line === q.line && p.column >= q.column);
  return (p) => after(p, start) && !after(p, end);
}

/**
 * The packages a project's files belong to: each file's is the folder of its nearest
 * package.json. The project's own packages are those of the files being checked. A .d.ts
 * in one of them describes the project's own JavaScript. A .d.ts in another folder outside
 * node_modules (a client generated into a folder with its own package.json, as Prisma's
 * custom output is, or a workspace package reached through a link) describes a package.
 */
export class PackageFolders {
  private readonly roots = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly own: ReadonlySet<string>;

  constructor(sourceFiles: readonly SourceFile[]) {
    this.own = new Set(sourceFiles.map((sf) => this.rootOf(sf, sf.getDirectoryPath())));
  }

  /** Whether a .d.ts describes the project's own code: its package is one of the files being checked. */
  isOwn(declarationFile: SourceFile): boolean {
    return this.own.has(this.rootOf(declarationFile, declarationFile.getDirectoryPath()));
  }

  /**
   * The package a declaration in a .d.ts outside node_modules and the project's own packages
   * belongs to, and its folder. It's named by its package.json, or else by its folder
   * (`./src/gen`, from the project's package). Undefined for anything else.
   */
  localPackage(declaration: Node): { name: string; folder: string } | undefined {
    const file = declaration.getSourceFile();
    if (!file.isDeclarationFile() || isInNodeModules(file) || this.isOwn(file)) return undefined;
    const root = this.rootOf(file, file.getDirectoryPath());
    const folder = root === "" ? file.getDirectoryPath() : root;
    let name = this.names.get(folder);
    if (name === undefined) {
      name = (root !== "" && packageJsonName(file, root)) || this.folderName(folder);
      this.names.set(folder, name);
    }
    return { name, folder };
  }

  /** The folder of the nearest package.json at or above `dir`; "" if there's none. */
  private rootOf(file: SourceFile, dir: string): string {
    const known = this.roots.get(dir);
    if (known !== undefined) return known;
    // ts-morph paths use `/`, with a drive letter on Windows: C:/app/src → C:/app → C:.
    const slash = dir.lastIndexOf("/");
    const parent = slash > 0 ? dir.slice(0, slash) : undefined;
    const root = file.getProject().getFileSystem().fileExistsSync(`${dir}/package.json`) ? dir : parent === undefined ? "" : this.rootOf(file, parent);
    this.roots.set(dir, root);
    return root;
  }

  /** A folder relative to the project's package that holds it (the innermost), else as it is. */
  private folderName(folder: string): string {
    const holders = [...this.own].filter((root) => root !== "" && folder.startsWith(`${root}/`));
    const holder = holders.sort((a, b) => b.length - a.length)[0];
    return holder === undefined ? folder : `./${folder.slice(holder.length + 1)}`;
  }
}

/** The `name` in a folder's package.json, if it has one. */
function packageJsonName(file: SourceFile, folder: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(file.getProject().getFileSystem().readFileSync(`${folder}/package.json`));
    const name = typeof parsed === "object" && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
    return typeof name === "string" && name.trim() !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

// --- names, comments, exports ------------------------------------------------

function unitName(node: Node): string {
  if (Node.isSourceFile(node)) return "<module>";
  if (isClass(node)) return `${className(node)}.constructor`;
  if (Node.isConstructorDeclaration(node)) return `${ownerName(node)}.constructor`;
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? "default";
  if (Node.isVariableDeclaration(node)) return node.getName();
  if (Node.isExportAssignment(node)) return "default";
  if (
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isPropertyAssignment(node) ||
    Node.isPropertyDeclaration(node)
  ) {
    return `${ownerName(node)}.${node.getName()}`;
  }
  return "<anonymous>";
}

/**
 * What a member belongs to: its class, or the declaration holding its object
 * literal or class expression (`const api = {...}`, `export const C = class {...}`,
 * `export default {...}`).
 */
function owner(member: Node): Node | undefined {
  const parent = member.getParent();
  if (!parent) return undefined;
  if (Node.isClassDeclaration(parent)) return parent;
  if (Node.isClassExpression(parent) || Node.isObjectLiteralExpression(parent)) {
    const holder = parent.getParent();
    if (holder && (Node.isVariableDeclaration(holder) || Node.isExportAssignment(holder))) return holder;
    return Node.isClassExpression(parent) ? parent : undefined;
  }
  return undefined;
}

function ownerName(member: Node): string {
  const o = owner(member);
  if (o && (Node.isClassDeclaration(o) || Node.isClassExpression(o))) return className(o);
  if (o && Node.isVariableDeclaration(o)) return o.getName();
  if (o && Node.isExportAssignment(o)) return "default";
  return "<anonymous>";
}

/** The declaration whose export status decides the unit's: members follow their class or object. */
function exportOwner(node: Node): Node {
  if (Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node)) return node;
  return owner(node) ?? node;
}

/**
 * Whether a unit can be reached from outside its file. Beyond what the file
 * exports directly: members of exported namespaces (`namespace A.B` too); members
 * of an object literal that's exported, at any depth (`export const api = { v1: {...} }`,
 * `export const routes = [{ handler }]`, a static field of an exported class); and
 * members of an object literal a function creates and hands back
 * (`return { get: () => fetch(...) }`), which escape with that function.
 */
function isExported(node: Node, exports: ReadonlySet<Node>): boolean {
  if (Node.isSourceFile(node)) return true;
  const decisive = exportOwner(node);
  if (exports.has(node) || exports.has(decisive) || exportedThroughNamespace(decisive)) return true;
  const parent = node.getParent();
  if (!parent || !Node.isObjectLiteralExpression(parent)) return false;
  const holder = literalHolder(parent);
  if (Node.isVariableDeclaration(holder) || Node.isExportAssignment(holder) || Node.isPropertyDeclaration(holder)) return isExported(holder, exports);
  const creator = enclosingUnitNode(parent);
  return !Node.isSourceFile(creator) && isExported(creator, exports);
}

/**
 * Objects of functions handed to a call, and the functions in them: `app.route({ handler(q) {...} })`,
 * `defineConfig({ plugins: [{ buildStart() {...} }] })`, or a const holding one, `app.use(routes)`.
 * Whatever they're handed to can call those functions. Handed out by a function, they're
 * charged to it (graph.ts); handed out by the file's top-level code, they're entry points,
 * like exported functions: route tables, plugin hooks, tool definitions.
 */
export function objectsHandedToCalls(sourceFile: SourceFile): { call: CallLike; members: Node[] }[] {
  const out: { call: CallLike; members: Node[] }[] = [];
  for (const literal of descendantsOfKind(sourceFile, SyntaxKind.ObjectLiteralExpression)) {
    const call = callReceiving(literal);
    if (call) out.push({ call, members: functionMembers(literal) });
  }
  for (const id of descendantsOfKind(sourceFile, SyntaxKind.Identifier)) {
    const call = callReceiving(id);
    if (!call) continue;
    const parent = id.getParent();
    const symbol = parent && Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : id.getSymbol();
    const declaration = symbol && resolveAlias(symbol).getDeclarations()[0];
    const value = declaration && Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
    if (call && value) out.push({ call, members: objectLiteralsIn(value).flatMap(functionMembers) });
  }
  return out.filter((o) => o.members.length > 0);
}

/**
 * The call a value is handed to as an argument, directly or inside the object and array
 * literals around it: `app.use(routes)`, `app.use({ routes })`, `define({ plugins: [p] })`.
 */
function callReceiving(value: Node): CallLike | undefined {
  let node = value;
  if (Node.isShorthandPropertyAssignment(node.getParent())) node = node.getParentOrThrow();
  for (let parent = node.getParent(); parent && isLiteralContainer(parent); parent = node.getParent()) node = parent;
  const call = node.getParent();
  if (!call || (!Node.isCallExpression(call) && !Node.isNewExpression(call))) return undefined;
  return call.getArguments().includes(node) ? call : undefined;
}

/** The object literals that make up a value: `{ ... }`, and those nested in its literals and arrays. */
function objectLiteralsIn(value: Node): ObjectLiteralExpression[] {
  const inner = unwrapExpression(value);
  if (Node.isObjectLiteralExpression(inner)) {
    return [inner, ...inner.getProperties().flatMap((p) => (Node.isPropertyAssignment(p) ? objectLiteralsIn(p.getInitializerOrThrow()) : []))];
  }
  if (Node.isArrayLiteralExpression(inner)) return inner.getElements().flatMap(objectLiteralsIn);
  return [];
}

/** An object literal's members that are functions: methods, accessors, `f: () => ...`. */
function functionMembers(literal: ObjectLiteralExpression): Node[] {
  return literal.getProperties().flatMap((p) => unitNodeForDeclaration(p) ?? []);
}

/** What holds an object literal, through the literals and arrays it's nested in: `api` in `const api = { v1: { ... } }`. */
function literalHolder(literal: Node): Node {
  let node = literal;
  while (isLiteralContainer(node.getParentOrThrow())) node = node.getParentOrThrow();
  return node.getParentOrThrow();
}

/** Syntax an object literal can sit in and still be part of the same value. */
function isLiteralContainer(node: Node): boolean {
  return (
    Node.isObjectLiteralExpression(node) || Node.isArrayLiteralExpression(node) || Node.isPropertyAssignment(node) ||
    Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) ||
    Node.isTypeAssertion(node) || Node.isSpreadElement(node) || Node.isSpreadAssignment(node)
  );
}

/** `export namespace Api { export function ping() {} }`, at any depth. */
function exportedThroughNamespace(node: Node): boolean {
  const statement = Node.isVariableDeclaration(node) ? node.getVariableStatement() : node;
  if (!statement || !Node.isExportable(statement) || !statement.hasExportKeyword()) return false;
  const block = statement.getParent();
  const namespace = block?.getParent();
  return block !== undefined && Node.isModuleBlock(block) && namespace !== undefined && Node.isModuleDeclaration(namespace) && namespaceExported(namespace);
}

function namespaceExported(namespace: ModuleDeclaration): boolean {
  const parent = namespace.getParent();
  // `namespace A.B {}`: B sits directly in A, and is exported with it.
  if (Node.isModuleDeclaration(parent)) return namespaceExported(parent);
  if (!namespace.hasExportKeyword()) return false;
  if (Node.isSourceFile(parent)) return true;
  const outer = parent?.getParent();
  return Node.isModuleBlock(parent) && outer !== undefined && Node.isModuleDeclaration(outer) && namespaceExported(outer);
}

function jsDocsOf(node: Node): Comment[] {
  if (Node.isVariableDeclaration(node)) {
    const statement = node.getVariableStatement();
    return statement ? jsDocComments(statement) : [];
  }
  const docs = jsDocComments(node);
  // An overloaded function's @perm may sit on any of its signatures.
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    // (Found through the symbol: ts-morph's getOverloads() scans every sibling, which is
    // slow in a file with thousands of functions.)
    const overloads = (node.getSymbol()?.getDeclarations() ?? []).filter((d) => d !== node && d.getKind() === node.getKind());
    return [...overloads.flatMap(jsDocComments), ...docs];
  }
  // A class expression's comment sits on what holds it: `/** @perm net */ export const C = class {...}`.
  if (Node.isClassExpression(node) && isFunctionHolder(node.getParentOrThrow())) return [...docs, ...jsDocsOf(node.getParentOrThrow())];
  return docs;
}

/**
 * Declarations exported from a file, including via `export { x }` and re-exports of local
 * names, and `export default` / `export =` assignments (with the function they name).
 * Also the file's entry points: functions its top-level code hands to a call in an object.
 */
export function exportedDeclarations(sourceFile: SourceFile): Set<Node> {
  const out = new Set<Node>();
  for (const symbol of sourceFile.getExportSymbols()) {
    for (const d of resolveAlias(symbol).getDeclarations()) out.add(d);
  }
  for (const assignment of sourceFile.getExportAssignments()) {
    out.add(assignment);
    const expression = assignment.getExpression();
    const symbol = Node.isIdentifier(expression) ? expression.getSymbol() : undefined;
    for (const d of symbol ? resolveAlias(symbol).getDeclarations() : []) out.add(d);
  }
  for (const { call, members } of objectsHandedToCalls(sourceFile)) {
    if (Node.isSourceFile(enclosingUnitNode(call))) for (const m of members) out.add(m);
  }
  return out;
}

/**
 * A class's name; for `const C = class {...}` (or a property holding one), the holder's; for
 * `export default class {}`, "default"; for one built by an expression, `make.<class>` after the
 * function it's in.
 */
function className(cls: ClassDeclaration | ClassExpression): string {
  const name = cls.getName();
  if (name) return name;
  const holder = cls.getParentOrThrow();
  if (Node.isVariableDeclaration(holder) || Node.isPropertyAssignment(holder) || Node.isPropertyDeclaration(holder)) return holder.getName();
  if (Node.isClassDeclaration(cls) || Node.isExportAssignment(holder)) return "default";
  // Built by an expression (returned from a function, a mixin, `new (class {...})()`): named by where.
  const around = enclosingUnitNode(cls);
  return Node.isSourceFile(around) ? "<class>" : `${unitName(around)}.<class>`;
}
