# PermLang reference

The details behind the [README](../README.md): what PermLang detects, how
capabilities match, adapters, the lock file, the GitHub Action, the CLI, and what
it can't see yet. New here? Start with [getting started](getting-started.md).

## What it checks

- **Annotations.** `@perm` tags in JSDoc on functions, methods, constructors,
  accessors, function-valued `const`s and properties (in classes and in object
  literals), `export default` functions, and a class with no constructor (the tag
  covers its implicit one: field initializers and the base constructor). An
  overloaded function's tag can sit on any signature. A `@perm` or `@perm-unsafe`
  anywhere else (an interface member, a variable that isn't a function, a class
  with a constructor, a statement) applies to nothing, and is an error (PERM002).
- **Direct calls.** The global `fetch` and Node's `fs` / `fs/promises`
  (including `node:` imports, renamed imports, and `fs.promises.*`).
- **Propagation.** A function's actual permissions include everything its
  callees use, across files, through re-exports, recursion, class methods,
  constructors, object methods, and functions passed as callbacks. Violations
  show the path:

  ```
  a calls b("{}"), reaching b → c → writeFileSync("./public/dump.json", ...)
    but its declared permissions do not include fs.write(./public/dump.json).
  ```

- **Module-level permissions.** A top-of-file JSDoc tagged `@module` (or
  `@file` / `@fileoverview`) applies its `@perm` to every function in the file:

  ```ts
  /**
   * Stripe integration.
   * @module
   * @perm net(api.stripe.com)
   */
  ```

  The one-line form works too: `/** @module @perm net(api.stripe.com) */`.

- **Missing annotations.** At the default strictness, an exported function
  or entry point with no `@perm` is an error (PERM003) for each capability it
  reaches. Private helpers need no annotation; their callers must cover what they
  use. See [exported functions and entry points](#exported-functions-and-entry-points)
  and [Strictness levels](#strictness-levels). Each suggested fix names a place
  the annotation attaches to: a `/** @module @perm ... */` comment for a file's
  top-level code, the class for an implicit constructor.
- **All v0.1 capabilities.**
  - `env`: any expression typed `NodeJS.ProcessEnv`, so `process.env.KEY`,
    `process.env["KEY"]`, destructuring, `"KEY" in process.env`, and aliases
    (`const env = process.env; env.KEY`). Spreading or enumerating the
    environment needs bare `env`. `process.env` (and `(process as any).env`) is
    read the same way without Node's types, or with a project's own
    `declare const process`; a `process`
    that doesn't resolve also gets a PERM007 warning, since its other APIs
    can't be checked. `import.meta.env.KEY` (Vite, Astro, and others) is
    `env(KEY)`, except what Vite sets itself (`MODE`, `DEV`, `PROD`, `SSR`,
    `BASE_URL`). `process.loadEnvFile(path)` needs `env` and `fs.read(path)`
    (`./.env` by default).
  - `exec`: `child_process` (`exec`, `execFile`, `spawn`, `fork`, and their
    `Sync` forms), `process.kill`, `process.execve`, and `cluster.fork` /
    `setupPrimary`.
  - `net`: also `http`, `https`, `http2`, `net`, `tls`, `WebSocket`,
    `EventSource`, `WebTransport`, `navigator.sendBeacon`, and
    `XMLHttpRequest`. The host comes from a URL, or from an options object the
    way Node reads it: the `http` family connects to `hostname` before `host`
    and ignores a `url` option; after a URL, an options `hostname` replaces the
    URL's host but a `host` doesn't (Node's URL parsing sets `hostname`); `net`
    and `tls` connect to `host` (or `connect(port, host)`) and ignore
    `hostname`. Other libraries' options must name one host in all of `url`,
    `hostname`, and `host`. A spread, an accessor, a computed key, or a
    `socketPath`, `lookup`, or `createConnection` option (or a `path` for `net`
    and `tls`) could send the connection anywhere, so it needs bare `net`. So do
    options that aren't written out where they're used (a variable, even one that
    may be `undefined`), and a first argument to `net.connect` or `tls.connect`
    that isn't a port number or written-out options.
  - `fs.read` / `fs.write`: `readFile` and `createReadStream` with a writing
    `flag` / `flags` option (`"w"`, `"a+"`, or one that can't be read) write the
    file, and used as values they could be called with any flags, as `open` can.
    `new fs.Utf8Stream({ dest })`, `ReadStream`, and `WriteStream` open their
    path. `fchmod`, `fchown`, and `futimes` (and a `FileHandle`'s `chmod`,
    `chown`, and `utimes`) change a file however it was opened, so they need
    `fs.write`. `process.chdir(dir)` needs `fs.read(dir)` and `fs.write(dir)`,
    because every relative path the program uses afterwards resolves inside
    `dir`.
  - `db`: **Prisma**. The table is the
    model's accessor name: `prisma.lead.create()` needs `db.write(lead)`. Raw
    SQL (`$queryRaw`, `$executeRaw`, ...) needs bare `db.read` and `db.write`.
    Related models count too: `include`, `select`, `where`, `orderBy`, `_count`,
    and the fluent API (`prisma.user.findUnique(...).posts()`) read them, at any
    depth, and nested writes in `data` (`create`, `update`, `deleteMany`, ...)
    write them. Linking a record (`connect`, `disconnect`, `set`) writes the table
    that holds the foreign key: the related model's for a list relation (a
    many-to-many link table counts as the related model's), and for a single
    relation only when the key is kept there; otherwise `connect` reads it.
    Arguments that aren't written out (a variable, a spread, a computed key) count
    by their type: one that can't name a relation adds nothing, and one that can,
    such as `Prisma.LeadWhereInput` or `any`, could reach any table, so it needs
    bare `db.read` (and `db.write` in `data`). Relations are read from the client
    generated by Prisma 5 or later; with an older client, any argument that could
    name one needs bare `db.read`. Prisma is recognized by its package and its
    generated client, including one generated into a custom `output` folder (which
    Prisma marks as generated), never by a folder's name.
  - `db`: **Drizzle**. The table is the name given to `pgTable` / `mysqlTable` /
    `sqliteTable`: `db.insert(auditLog)`, with `const auditLog = pgTable("audit_log", ...)`,
    needs `db.write(audit_log)`. `pgSchema("s").table("t")` is `s.t`, and `alias(t)`
    is `t`. A name PermLang can't read (computed, from `pgTableCreator`, or held in a
    `let`) could be any table. `.from()` and joins read. `db.query.<key>.findMany()`
    reads `<key>` and each `with` relation, nested ones included; options that
    aren't written out could load any. `db.execute()` is raw SQL, and `migrate()`
    can touch any table. A `` sql`...` `` fragment is read like raw SQL where it's
    written, whether it's a whole statement or stands for an expression in a query
    (`` .where(sql`EXISTS (SELECT 1 FROM secrets)`) ``, a select field, `.set()`,
    `.orderBy()`): a table substituted into it (`${secrets}`) is named by its
    definition, and other substitutions are values. `sql.raw("...")` is read the
    same way, and `sql.raw(text)` with text PermLang can't read could touch any
    table, as can a fragment calling a function it doesn't know. SQL in a schema
    definition (a column default or generated column, a check, an index condition,
    a view, a policy) runs inside the database, so it isn't counted.
  - `db`: **raw SQL clients** (`pg`, `mysql2`, `better-sqlite3`, `sqlite3`,
    `postgres`, `@neondatabase/serverless`, `@vercel/postgres`). When the query
    is literal text, its tables are read out of it: `SELECT ... FROM leads JOIN
    teams` needs `db.read(leads), db.read(teams)`. Tagged templates (`` sql`...` ``)
    count, because their substitutions are bound parameters, unless a substitution
    is itself SQL (a postgres.js fragment or `sql(name)` helper). The reader fails
    closed: it names tables only for a single `SELECT`, `INSERT`, `UPDATE`, or
    `DELETE` it fully understands. Anything else (`WITH`, `UNION`, DDL, `COPY`,
    `PRAGMA`, more than one statement) can touch any table, as can text that
    databases read differently (MySQL's `--` with no space after it, backslashes,
    executable comments such as `/*! ... */`), a function it doesn't know to be
    harmless (including `lower` called through a schema, `evil.lower(x)`, or a quoted
    name), a parenthesized list after an `INSERT` table that isn't a list of
    columns, a quoted name it can't report as written (`"audit.log"`), and SQL nested
    more than 64 levels deep. So can SQL built with string concatenation or a
    template passed to `query()`; a config object (`{ text }`, `{ sql }`) with a
    spread, a computed key, or the SQL named twice, any of which can replace the
    text; a mysql2 value with a `toSqlString()` method (what `mysql.raw()` returns),
    whose text mysql2 pastes into the query; and a tag called as a function with
    an array made to look like a template's strings. These need bare `db.read`
    and `db.write`. Neon's query function called with SQL text (before 1.0) is read
    like `query()`. So does any client method PermLang doesn't know, so new APIs
    can't pass silently; postgres.js's query modifiers (`.values()`, `.cursor()`,
    `.describe()`, ...) and mysql2's `.promise()` touch nothing beyond the query
    they belong to. Schema-qualified names are declared as written
    (`db.read(public.users)`).
- **Adapter manifests.** JSON files mapping a library's functions to
  capabilities, including app-level ones such as `payments.refund`. Built-in
  adapters in [`adapters/`](../adapters) cover HTTP clients, Stripe, email, Redis,
  Kafka, queues, AI SDKs, and more (see [below](#adapter-manifests)). Library
  calls resolve by signature, so aliasing a method (`const post = axios.post`)
  doesn't hide it.
- **Escape hatch.** `@perm-unsafe reason:"..."` suppresses one function's
  own checks. Every use is listed in the report. Callers still have to cover
  what the function reaches.
- **Adversarial coverage.** Tricks that try to hide access are caught:
  - capability functions used as values: `urls.map(fetch)`, `promisify(exec)`,
    `paths.forEach(unlinkSync)`, `{ fetch }`. `send.call(thisArg, url)` and
    `send.apply(thisArg, [url])` are checked as calls, with their arguments. Calls
    through a `const` alias resolve to the original; the alias used as a value
    (`const run = execSync; run.call(null, cmd)`, `Reflect.apply(run, ...)`,
    `urls.map(get)` with `const get = fetch`) is a use of what it holds. Testing
    whether a function exists (`if (globalThis.fetch)`, `!WebSocket`,
    `x instanceof WebSocket`, `if (ready && window.WebSocket)`) isn't a use, but
    picking one with `&&`, `||`, or `??` outside a condition
    (`const WS = window.WebSocket || Fallback`) is;
  - capability classes reached indirectly: through an alias
    (`const WS = WebSocket`), a subclass, `super(url)`, a `typeof WebSocket`
    parameter, or `Reflect.construct(WebSocket, ...)`;
  - browser APIs in indirect forms: `navigator.sendBeacon.call(...)`,
    `XMLHttpRequest.prototype.open.call(...)`, `window.setTimeout("code")`;
  - calls through an interface or base class, which reach every first-party
    implementation (see [how calls are followed](#how-calls-are-followed));
  - `super()`, implicit constructors, instance field initializers, classes built
    by expressions, and mixins;
  - `{ helper }` shorthand, getters, and literal computed keys (`api["ping"]()`);
  - computed keys over a known object (`handlers[kind]()`), which reach every
    member the key allows;
  - methods the language calls without a visible call (`await`, `for...of`,
    spreading, destructuring, arithmetic and comparisons, `using`, `instanceof`);
  - importing a module, which runs its top-level code (`import`, `export ... from`,
    `import x = require()`, `require()`, and `import()`, including one whose
    specifier is a `const`, an `as const` property, or an enum member).
- **Unverifiable code (PERM004).** Code whose effects can't be determined is
  an error in annotated functions: `eval`, `new Function`, `setTimeout("code")`,
  `vm`, `new Worker` (Node's, and the browser's `Worker`, `SharedWorker`, and
  `importScripts()`), native code and hooks (`process.dlopen`,
  `crypto.setEngine`, `module.register`, `registerHooks`, `runMain`,
  `module.require`, `new Module()`), the inspector's `Session.post`,
  `process.binding()`, `process.getBuiltinModule(name)` with a computed name (a
  literal name is like importing the module), computed calls on sensitive
  objects (`fs[method]()`, `globalThis[name]()`) or behind an index signature
  (`table[name]()`), loading a module whose result can't be checked (see
  [loading modules](#loading-modules)), calls into the project's own JavaScript
  through a hand-written `.d.ts`, and a file PermLang couldn't analyze (code
  nested thousands of levels deep, say). The only way to accept it is
  `@perm-unsafe`, which also stops it from failing the function's callers.
- **Project configuration (PERM005).** GitHub workflows, Actions, and
  `package.json` scripts are recorded in the lock like code: token permissions,
  secrets, Actions and whether they're pinned, install hooks. See
  [project configuration](#project-configuration).
- **Tools given to AI models (PERM008).** Functions registered as AI tools, and
  what a model can trigger through them. See
  [tools given to AI models](#tools-given-to-ai-models).
- **Data-flow rules (PERM009).** Where a secret or sensitive data may be sent.
  See [data-flow rules](#data-flow-rules).
- **New dependencies** in the permission diff, with what PermLang sees of each
  and its install scripts.
- **Strictness levels, a lock file, a permission diff for pull requests, a
  GitHub Action with line annotations and code scanning, and SARIF output.** See
  below.

### How calls are followed

A function reaches everything the functions it can run reach. PermLang links
them by what the code says, not by names:

- **Calls and references.** A call links to the declaration it resolves to. So
  does passing a function on (`urls.map(handler)`, `setTimeout(handler)`): the
  receiver can call it.
- **Interfaces and base classes.** A call or read through an interface, a type
  alias, or a base class (`s.send(u)`, `urls.map(s.send)`, `s.send.call(...)`,
  `this.url` for a getter) reaches every first-party implementation: classes
  that extend or implement the type, object literals written against it, and,
  for an interface or object type, any class or object literal in the project
  that could be used as one, since TypeScript doesn't require `implements`. A
  generic type is compared by the members it requires. Members declared as
  function-typed properties (`send: (u: string) => void`) count like methods.
- **Objects of functions handed to a call.** A function that passes an object
  holding functions (`app.use({ run(q) {...} })`, or a `const` holding one,
  nested in arrays and objects too) reaches those functions. Handed out by a
  file's top-level code, they're entry points instead (see below).
- **Implicit calls.** `await x` runs `then`; `for...of`, spreading an array,
  array destructuring and `yield*` run the iterator; template literals,
  arithmetic, comparisons, `==`, compound assignment, and unary `+` `-` `~`
  `++` `--` on an object run `valueOf` / `toString` / `[Symbol.toPrimitive]`;
  destructuring (including quoted, numeric, and computed keys, and
  `({ a } = b)`) and `{ ...b }` run getters; `using` and `await using` run
  `[Symbol.dispose]` / `[Symbol.asyncDispose]`; `instanceof` runs the class's
  static `[Symbol.hasInstance]`.
- **Classes.** `new` runs the constructor, or the implicit one (field
  initializers and the base constructor). A class built by an expression
  (returned from a function, a mixin, `new (class {...})()`) is found through
  the type of what's constructed, and named after where it's built
  (`make.<class>.constructor`).
- **Decorators.** A class decorator (`@logged` or `@logged()`) runs with the
  code that defines the class. A member's decorator is charged to the member.
- **Recursion.** Functions that call each other reach what any of them does.

Paths in messages keep their first 20 steps and their last 3.

### Exported functions and entry points

At the default strictness, these must declare what they reach:

- exported functions, classes and their members, and members of exported
  namespaces (`namespace A.B` too);
- functions in an exported object or array, at any depth
  (`export const api = { v1: { run() {} } }`, `export const routes = [{ handler }]`,
  a static field of an exported class), and `export default {...}` /
  `export = {...}` / `export = run`;
- members of an object a function returns or hands out, if that function is
  exported;
- functions that top-level code hands to a call inside an object: route tables
  (`app.route({ handler(q) {...} })`), plugin hooks
  (`defineConfig({ plugins: [{ buildStart() {...} }] })`), AI tool definitions,
  `Proxy` handlers;
- the file's top-level code, which runs on import. It also reaches any function
  it passes on: `export default withAuth(handler)` or
  `export default { fetch: handler }` reaches `handler`.

### Loading modules

`import`, `export ... from`, `import x = require()`, and `import()` with a literal
specifier are typed by TypeScript, so calls on what they load are checked like
any others. `require()` in TypeScript, and `import()` with a specifier that isn't
written as a literal, give `any`. PermLang traces the specifier (a literal, a
`const`, an `as const` property, an enum member) and goes by what it names:

| Loaded | Result |
| --- | --- |
| a file in the project | its top-level code runs, and any of its exports can be called: the caller reaches all of them |
| a module whose functions carry capabilities (`child_process`, `fs`, a Node built-in that isn't declared pure, a database client, a package an adapter maps) | unverifiable |
| a package with no adapter | listed and warned about (PERM006), like an import of it |
| a package declared pure, JSON, or another asset | nothing |
| a specifier that can't be traced, or a file outside the project | unverifiable |

`data:`, `http:`, `https:`, `blob:` and `file:` specifiers are unverifiable in
every form of import: the code isn't a file in the project. A query or fragment
doesn't make a script an asset (`./evil.js?x=.css` is still `./evil.js`).

### Known limits

The aim is to catch the whole adversarial suite, or to document each miss. These misses are documented as fixtures in
[`fixtures/m4/limits/`](../fixtures/m4/limits) and [`fixtures/m6/limits/`](../fixtures/m6/limits),
and as "known misses" in the adversarial suite
([`test/adversarial.test.ts`](../test/adversarial.test.ts)), which also lists
the harmless code that must stay silent. Each miss's test fails once it's fixed,
so the list can't go stale.

- Values typed `any`: nothing called on them can be resolved. Where a value
  with known capabilities becomes `any`, the escape itself is checked:
  - A member read off a cast is looked up on the original type and reported as
    the access it is: `(globalThis as any).fetch(url)`,
    `(childProcess as any)["exec"](cmd)`, `(process as any).env.KEY`,
    `(globalThis.process as any).env.KEY`, and down a chain of members
    (`(window as any).navigator.sendBeacon(url)`) or into a constructor
    (`new (globalThis as any).WebSocket(url)`). Casts to `Record<string, any>`
    and through `unknown` count too.
  - A capability module is any value whose type is one: a namespace or default
    import, `import cp = require(...)`, the result of `await import(...)` or
    `process.getBuiltinModule(...)`, or a module of the project's own that
    re-exports one. One that escapes any other way (stored, passed, or returned
    as `any`; passed on as `unknown`, `object`, `{}`, or a record such as
    `Record<string, unknown>`; listed with `Object.values`, `entries`, or
    `keys`; read or written with a computed key, also by `Reflect.get`; or
    given to a callback parameter typed `any` or `unknown`, as in
    `Promise.resolve(cp).then((m: any) => ...)`; or given as `this` to a function
    of the project's own, as in `run.call(cp)`) is unverifiable (PERM004).
    Passed to a parameter of its own type (`function run(m: typeof cp)`), it's
    checked through that parameter like the module itself.
  - `const f: any = fetch` counts as using `fetch`, and `declare const require: any`
    and `(require as any)(...)` are still `require`.

  Two things stay unchecked. A global object stored as `any`
  (`const w = window as any; w.fetch(url)`) isn't followed: that cast is common
  and almost always harmless, so it isn't reported. And a value that was `any`
  from the start, such as an untyped parameter, has nothing to trace; that
  includes a module handed through a promise or a collection to a named
  function whose parameter is `any` (`Promise.resolve(cp).then(handle)`, with
  `function handle(m: any)`), since only callbacks written in place are
  matched to what they're given. A module that's passed on from somewhere other
  than its own name (an array element or an object's property, as in
  `use(modules[0])`) isn't followed either. Imports
  whose types can't be found, including packages shimmed with
  `declare module "x";`, are reported (PERM007), whether reached by `import`,
  `import x = require()`, or a literal `import()`.
- `Proxy` traps, which can return a capability function for any property. A
  handler's traps are entry points (or charged to the function creating the
  `Proxy`), but a call through the `Proxy` isn't linked to them.
- Functions attached after the fact (`obj.m = fn`, reassigning a `let`) aren't
  linked to calls through that property or variable. The top-level code that
  assigns them is still reported.
- Implicit calls made inside a library function: `Promise.resolve(x)` calling
  `then`, `Array.from(x)` running an iterator, `String(x)` calling `toString`.
  Written directly (`await x`, `for...of`, `${x}`, `"" + x`), they're caught.
- `as const` objects and enum members are trusted as fixed values, though code
  can change them at runtime. Every reference to one is checked for a write (an
  assignment, `delete`, `++`, or destructuring into a member; a cast; or
  `Object.assign`, `Object.defineProperty`, `Reflect.set`, and the like with it
  as the target), and values read from a written object are unknown. An object
  passed to a function that writes to it, or stored in another variable first,
  isn't followed ([`fixtures/m6/limits/constant-written-elsewhere.ts`](../fixtures/m6/limits/constant-written-elsewhere.ts)).
  Treating every such value as unknown instead would turn most uses of
  constants into bare capabilities.

Other gaps, not yet in fixtures:

- Third-party packages without an adapter: what they touch is trusted. They are
  listed in every report and warned about (PERM006; see below).
- A `ProcessEnv` received as a parameter typed as a plain object.
- The browser loading a resource for the page (an image's `src`, a script or
  stylesheet element, a CSS `url()`) or leaving it (`location.href = url`,
  `window.open(url)`, a form submission), which reaches the network without a
  network API call.
- Calling a method on an object Node's built-ins return isn't new access:
  `socket.write()` after `net.connect()`, `child.kill()` after `spawn()`. The
  access is checked where the object was made, so an object made somewhere
  PermLang can't see (a `ChildProcess` constructed directly and spawned through
  its undocumented `spawn` method, say) isn't reported.
- A member's decorator, and a decorator's arguments, run when the class is
  defined, but are charged to the decorated member. So at the default
  strictness, a member decorator on a class that isn't exported isn't checked.
- JavaScript behind the project's own hand-written `.d.ts` isn't analyzed: calls
  into it are unverifiable, but importing it (which runs its top-level code) isn't
  reported, and neither is reading a property it declares. To have it checked,
  convert it to TypeScript; PermLang doesn't analyze the `.js` even with
  `allowJs`, as long as the `.d.ts` describes it. Declarations that describe the
  runtime (`declare global`, a `.d.ts` with no imports or exports) or a package
  (`declare module "x"`, a folder with its own `package.json`, such as a
  generated Prisma client) are trusted like a package with no adapter.
- `require()` of a package an adapter maps is unverifiable, rather than reaching
  the capabilities the adapter lists; use `import` to have its calls checked.
- A file loaded with `require()` or a traced `import()` reaches every export of
  that file, used or not.
- Interfaces are matched structurally, so a class or object literal that merely
  fits an interface counts as an implementation of it, even if it's never used
  as one.
- A file that TypeScript itself can't parse (code nested thousands of levels
  deep) is unverifiable when the project's file list includes it. One reached
  only through imports from outside that list still stops the check.
- Lock keys for same-named functions in one file (`#2`, `#3`) follow source
  order, so adding one can renumber the others and show spurious lock changes.
- The Action knows whether the lock file existed before only on pull requests
  and merge-queue entries, from their base commit. On a push, a deleted lock
  file isn't detected.
- A pull request that changes the Action's `args` to use a new `--lock` file,
  one the base commit doesn't have, isn't held to the old one: the check uses
  the new file, and the comment lists all access as new and says the base has
  no lock file.
- New dependencies are described with the pull request's own adapters. An
  adapter the pull request adds or changes is itself a settings change, which
  fails the check and is listed in the comment.
- Of tsconfig.json's compiler options, only those that decide which files are
  read and what imports and globals resolve to are recorded (see
  [what the lock records](#what-the-lock-records)).
- If the Action can't look up the account its token belongs to, it assumes
  `github-actions[bot]`; with another kind of token, it then adds a new comment
  on each push instead of updating one.
- Databases run code of their own that SQL text doesn't show: triggers, views,
  rules, and row-level security can read or write other tables.
- Table names in SQL are reported as written. Postgres folds unquoted names to
  lower case, so `LEADS` and `"LEADS"` are different tables there but are both
  reported as `LEADS`.
- A mysql2 value typed `any` that has a `toSqlString()` method: mysql2 pastes its
  text into the query, but nothing in its type shows that.
- A Drizzle `` sql`...` `` fragment's tables are charged to the code where the
  fragment is written. One kept in a shared constant counts toward its module's
  top-level code (and so toward every importer), not toward each query that uses it.
- Prisma relations are read from the payload types that Prisma 5 and later
  generate. With an older client, any `include`, `select`, or nested argument that
  could name a relation needs bare `db.read` (and `db.write` in `data`).

## Configuration

`permlang.config.json`, next to the lock file. Every setting is optional.

```json
{
  "strictness": "development",
  "unmapped": "warn",
  "tools": "warn",
  "adapters": ["./permlang/adapters/acme-sms.json"],
  "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }]
}
```

| Setting | Values | Meaning |
| --- | --- | --- |
| `strictness` | `sketch`, `development` (default), `production` | What fails the build. See [strictness levels](#strictness-levels). The `--strictness` option overrides it. |
| `unmapped` | `warn` (default), `error`, `trust` | Calls into packages with no adapter, and imports with no types. See [packages without an adapter](#packages-without-an-adapter). The `--unmapped` option overrides it. |
| `tools` | `warn` (default), `error`, `trust` | AI tools that reach something dangerous. See [tools given to AI models](#tools-given-to-ai-models). |
| `adapters` | paths | Your own adapter manifests, relative to the config file. See [adapter manifests](#adapter-manifests). |
| `flows` | rules | Where protected data may go. See [data-flow rules](#data-flow-rules). |

Any other key is an error (exit code 2) that names it, since a typo such as
`"strictnes"` would otherwise leave the default in place unseen. `"$schema"` is
allowed.

The settings in effect, after command-line options, are recorded in the lock
file along with the paths checked, so changing them fails the check until
`permlang lock` records the change. See [what the lock records](#what-the-lock-records).

## Diagnostic codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `PERM001` | error | A function reaches a capability its `@perm` doesn't declare. |
| `PERM002` | error | An `@perm` annotation is invalid, or attaches to nothing. |
| `PERM003` | error | A function that must declare its permissions has no `@perm`: exported functions at development, every function at production. See [strictness levels](#strictness-levels). |
| `PERM004` | error | Code whose effects can't be determined statically, such as `eval` or a capability hidden behind `any`. |
| `PERM005` | error | The code and `permlang.lock.json` differ: the code reaches something the lock doesn't record, or the lock records something the code no longer reaches; a `@perm-unsafe` override is new, gone, or has another reason; the check ran on other files or with other settings than the lock records; the lock is missing (with `--require-lock`); or an older PermLang wrote it. See [the lock file](#the-lock-file-and-the-permission-diff). |
| `PERM006` | warning, by default | A call into a package with no adapter: what it touches isn't checked. See [packages without an adapter](#packages-without-an-adapter). |
| `PERM007` | warning, by default | An import whose types can't be found, so nothing called from it is checked. Also the global `process` when Node's types are missing (reported as `node:process`). |
| `PERM008` | warning, by default | A tool an AI model can call reaches something dangerous. See [tools given to AI models](#tools-given-to-ai-models). |
| `PERM009` | error | A function gets hold of data a flow rule protects and can send it somewhere the rule doesn't allow: another host, a command, or code that can't be verified. See [data-flow rules](#data-flow-rules). |
| `SPEC001`–`SPEC005` | error or warning | Problems with `.perm` specs: see [specs](#specs-phase-2-groundwork). |

At sketch strictness, the rules about `@perm` annotations (`PERM001` to `PERM004`) are
warnings. What you ask for explicitly still fails: `PERM005` (the lock file),
`PERM009` (flow rules), and `PERM006`, `PERM007`, or `PERM008` when their policy is
`"error"`.

## Capabilities

| Capability | Meaning | Matching |
| --- | --- | --- |
| `net(host)` | outbound network | exact host, case-insensitive |
| `fs.read(path)` / `fs.write(path)` | file system | the path or anything beneath it |
| `db.read(table)` / `db.write(table)` | database | exact table |
| `env(NAME)` | environment variables and secrets | exact name |
| `exec` | spawning processes | none |

Wildcards (`*`) are not allowed. A capability without an argument (`net`,
`fs.read`) allows any scope. It is required when the host or path can't be
determined statically, for example `fetch(url)` or a template path like
`` `./data/${name}` ``.

Paths match whole folders after `..` is resolved: `fs.read(./data)` covers
`./data/a.json` but not `./database.json` or `./data/../x`. A path only matches
paths under the same root. A relative path never matches an absolute one, since
where it lands depends on where the program runs. On Windows, a drive (`C:\`), a
network share (`\\server\share`), and a drive-relative path (`C:x`, which is
relative to drive C's own working directory) are each separate roots, so
`fs.write(/evil)` doesn't cover `\\evil\share\x`, and `fs.read(.)` doesn't cover
`C:..\x`. Drive letters match in any case.

## Data-flow rules

`@perm` says what a function may touch. A flow rule says where protected data
may *go*: "the Stripe key may only be sent to Stripe".

```json
{
  "flows": [
    { "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] },
    { "from": "db.read(customers)", "to": ["net(api.hubspot.com)"] }
  ]
}
```

`from` is data a function reads: `env`, `fs.read`, `db.read`, or `net` (what a
host sends back), with or without a scope. `to` lists the network hosts it may
go to. Anything else, such as `"to": ["fs.write(./public)"]` or `"from": "exec"`,
is a configuration error, and so is a misspelled setting in a rule: none of them
could ever match.

A function that gets hold of the `from` data, and can send it somewhere `to`
doesn't allow, is a `PERM009` error. "Somewhere" is:

- a host `to` doesn't list, or a host that can't be determined (`fetch(url)`);
- a command (`exec`), or code that can't be verified (`eval`, say): either one
  could send it anywhere, so no rule can allow it.

It's an error at every strictness level, sketch included: a rule is something you
asked for.

That covers sending it itself or through anything it calls. The error points at
the call that leads there:

```
src/billing.ts:9:9 error PERM009: charge reads env(STRIPE_KEY) and can send to net(analytics.example), through track → fetch("https://analytics.example/event", ...), which the flow rule for env(STRIPE_KEY) doesn't allow.
  -> keep env(STRIPE_KEY) away from that call, or add net(analytics.example) to the rule's "to" in permlang.config.json.
```

A function gets hold of the data when it reads it, or when it calls a function
that has it and can hand it back:

- by returning a value: a getter such as `stripeKey()`, or a function whose result
  could carry the key, even one that returns only what Stripe sent back;
- by calling a callback the caller passed in (`withKey((key) => ...)`);
- as the object a constructor builds (`new StripeClient()`), or what a module
  exports.

A function that calls one that returns nothing (`void`, or `Promise<void>`) and
takes no callback isn't flagged for what it sends elsewhere: the data can't come
back to it. So `checkout()` calling `chargeCustomer(): Promise<void>` and then an
analytics service passes.

A `from` without a scope covers a whole category: `"env"` protects every
environment variable. Reading the whole environment (`JSON.stringify(process.env)`)
counts as reading every variable.

**This doesn't follow the value itself.** It works from which functions can get
hold of the data and what they can reach, so:

- data stored somewhere and read by other code isn't followed: a key read into a
  module-level constant, or into an object's field by one method and sent by
  another;
- a function that returns a value is assumed to hand the data back even when its
  result can't contain it, so a caller that also sends elsewhere is flagged;
- data that leaves through a thrown error isn't followed;
- a command inherits the whole environment, so one run by a function that never
  touches the key can still read it. Only commands run by functions that get
  hold of the data are flagged.

## Tools given to AI models

A function registered as a tool for an AI model runs when the model decides to
call it, and the model does what its input tells it to. So whoever controls that
input (a user, a web page the model reads, an email it summarizes) can trigger
the tool. If the tool can run commands, that's prompt injection turned into
code execution.

PermLang finds tool registrations and works out what each tool's handler can
reach, through everything it calls:

| Framework | Recognized |
| --- | --- |
| Vercel AI SDK (`ai`, `@ai-sdk/*`) | `tool({ execute })`, `dynamicTool(...)`; plain objects in a `tools` option, such as `generateText({ tools: { shell: { execute } } })` or `new ToolLoopAgent({ tools })`, written in the call or in a constant, spreads included; provider tools such as `anthropic.tools.bash_20250124({ execute })` |
| MCP (`@modelcontextprotocol/sdk`, and version 2's `@modelcontextprotocol/server`) | `server.tool(name, ..., handler)`, `server.registerTool(name, config, handler)`, and the handler that serves every tool (named `*`): `setRequestHandler(CallToolRequestSchema, handler)`, or `setRequestHandler("tools/call", handler)` in version 2 |
| OpenAI Agents (`@openai/agents`, `@openai/agents-*`) | `tool({ name, execute })`, and the built-in tools that run here: `shellTool({ shell })`, `computerTool({ computer })`, `applyPatchTool({ editor })` |
| LangChain (`@langchain/*`, `langchain`) | `tool(func, ...)`, `new DynamicStructuredTool({ func })`, other `new ...Tool(...)` classes, prebuilt tools that extend `Tool` (such as `new Calculator()`), and your own subclasses of `StructuredTool` or `Tool`, including class expressions (what their `_call` reaches) |
| LlamaIndex (`llamaindex`, `@llamaindex/*`) | `FunctionTool.from(fn, ...)` and `tool(fn, ...)` |
| Anthropic (`@anthropic-ai/*`), Mastra (`@mastra/*`) | their `tool`/`createTool`/`betaTool`-style helpers with an `execute`, `run`, or `func` handler, and plain objects with one in a `tools` list (the Anthropic SDK's `toolRunner({ tools: [{ name, run }] })`) |

A package counts by its family, because one package often re-exports another's
(`@openai/agents` re-exports `tool` from `@openai/agents-core`). The handler is
the last function argument when there is one (MCP's callback, LangChain's
`func`), else the definition's function-valued `execute`, `run`, or `func`, else a
built-in tool's `shell`, `computer`, or `editor` object, whose methods are what
runs. A schema property that happens to be called `run` isn't a handler.

Every tool is listed in the report, with what it reaches. When a tool reaches
something a model shouldn't trigger unchecked, there's a `PERM008` warning at
the registration:

- running commands (`exec`) or code that can't be verified;
- writing files or data (`fs.write`, `db.write`);
- sending to a host that isn't fixed (bare `net`), since the model can choose
  where data goes;
- reading a file, table, or environment variable that isn't fixed (bare
  `fs.read`, `db.read`, `env`, which also means reading the whole environment),
  since the model can choose what it reads and gets back;
- app-level actions from adapters, such as `payments.refund` or `email.send`.

Reading a fixed file, table, environment variable, or host doesn't warn: that's
what tools are for. Set `"tools"` in `permlang.config.json` to `"error"` to fail
the build instead (at every strictness level, sketch included), or `"trust"`
to only list them.

In the pull-request comment, new access a tool can reach is marked *An AI model
can trigger this*, with the tool's name.

What counts as unverifiable, and what reaches nothing:

- A handler PermLang can't follow counts as unverifiable: a parameter, a
  variable that can be reassigned, a value from a package with no types, or
  constants that refer to each other. A library function given as the handler
  (`execute: execSync`) reaches what PermLang knows that function does. A
  library's object or class instance (`shell: sandboxShell`,
  `editor: new RemoteEditor()`), or a computer factory typed only with the
  library's interface, is unverifiable: the framework calls its methods, and
  their code can't be seen.
- A tool without a handler here counts as unverifiable too, unless its type says
  it runs at the model provider: the AI SDK hands its calls back to your app, a
  provider tool like `bash_20250124()` runs them in whatever sandbox the call is
  given, and a library's prebuilt tool runs its own code.
- A tool whose framework types it as running at the provider reaches nothing
  here: OpenAI Agents' `HostedTool` (`webSearchTool()`, `fileSearchTool(...)`, a
  hosted `shellTool({ environment })`) and the AI SDK's `ProviderExecutedTool`
  (Anthropic's code execution). A type of your own with such a name doesn't count.

Not recognized yet:

- Tools registered through a wrapper of your own.
- Plain-object tools passed through anything but the call itself or a constant
  (a function's parameter, say), including a whole `tools` list or record passed
  in that way.
- Tool lists that are only schemas, such as the `tools: [...]` of the Anthropic or
  OpenAI SDK's message calls. Your own code answers the model's calls there,
  wherever it handles them, and PermLang can't link that code to the tool.

## Project configuration

Workflows and scripts grant as much as code does, and AI agents edit them as
readily. So the lock also records, for the folder it lives in:

- **GitHub workflows** (`.github/workflows/*.yml` and `*.yaml`);
- **Actions in the repository:** `action.yml` or `action.yaml` at the root, under
  `.github/actions/`, and in every folder a step runs with `uses: ./path`;
- **`package.json` scripts,** at the root and in every
  [workspace package](#workspaces).

File names are matched in any case (`CI.YML`, `Action.yaml`): a runner on a
case-insensitive file system finds them, and recording a file that never runs is
harmless.

Each file is an entry in the lock, keyed by its path (for example
`.github/workflows/ci.yml#<ci.yml>`), and what it grants are its capabilities:

| Capability | Meaning |
| --- | --- |
| `ci.trigger(event)` | An event the workflow runs on, such as `pull_request_target`. |
| `ci.permission(scope: level)` | A token permission a job gets, from its own `permissions:` or the workflow's. `ci.permission(write-all)` and `ci.permission(read-all)` for the shorthands; `ci.permission(default)` when neither sets any, or `permissions:` has no value, so the token gets the repository's default, which can be write access to everything. `permissions: {}` grants nothing, so it records nothing. |
| `ci.secret(NAME)` | A secret an expression reads, named in upper case as GitHub stores it ([how they're found](#how-workflows-are-read)). `ci.secret(inherit)` for a reusable workflow called with `secrets: inherit`; `ci.secret(all)` when an expression reads secrets whose names aren't written out. |
| `ci.action(owner/repo)` | An Action or reusable workflow a step or job runs (`uses:`). And a container image, as `ci.action(docker://name)`: a `uses: docker://` step, a Docker Action's `image:`, a job's `container:`, and its `services:`. An image's name is everything but its tag and digest, so its registry, port, and path are kept: `docker://ghcr.io:443/acme/tool`. |
| `ci.unpinned(owner/repo)` | ...referenced by a tag or branch rather than an exact commit, or for an image, by a tag rather than a `@sha256:` digest, so what runs can change without a change here. A `uses: ./path` is unpinned when the repository has no `action.yml` (or Dockerfile) in that folder: something else puts it there at run time. |
| `npm.script(name: command)` | A `package.json` script and its command, lifecycle hooks such as `postinstall` included. |
| `ci.unverifiable(sha256:…)`, `npm.unverifiable(sha256:…)` | A file, or part of one, PermLang can't read: YAML that doesn't parse, a workflow without both `on:` and `jobs:` (GitHub wouldn't run it as written, and stray invisible characters can make PermLang and GitHub read it differently), an alias with no anchor before it, an image named by an expression, a link that leads nowhere. It's recorded rather than skipped, so it can't hide anything, with the file's SHA-256, so that any edit to the file changes the lock and shows in review. Line endings and a byte-order mark don't count, since Git can change them on checkout. |

A change that adds one fails the check (`PERM005`) at the line that grants it,
and shows in the pull-request comment, until `permlang lock` records it. So does
a change that removes one, or a lock that records one the files don't grant.
That's the same review gate as for code. Updating a pinned Action to a new commit
doesn't change the lock, but switching it to a tag does.

### How workflows are read

PermLang reads workflows and Actions the way GitHub does, so that what it records
is what runs:

- **Anchors and aliases** (`&name`, `*name`), which GitHub supports since 2025, are
  followed everywhere, keys included. A trigger, a permissions block or level, a
  step, an Action, or `secrets: inherit` written through an alias is recorded at the
  line of the alias. An alias with no anchor before it, or inside the node it names,
  is unverifiable. **Merge keys** (`<<: *defaults`) are expanded too, although GitHub
  rejects them today, so nothing they bring in is missed if it ever accepts them. A
  key written next to one doesn't replace the merged one: both are recorded.
- **YAML 1.2,** whatever a `%YAML 1.1` directive says, so `on:` is always the
  trigger key, as it is to GitHub.
- **`${{ 'text' }}` is the text** in any key or value, as it is to GitHub:
  `uses: ${{ 'owner/repo@main' }}` runs `owner/repo@main`.
- **`uses:` counts only where GitHub runs it:** on steps (also steps grouped under
  `parallel:`) and on jobs that call a reusable workflow. A `uses:` key under
  `with:` or `env:` is just an input.
- **Secrets are read from expressions:** every `${{ }}`, in keys as well as
  values, and `if:` conditions, which are expressions without `${{ }}`. Text outside
  an expression, such as `name: see docs/secrets.md`, isn't. GitHub matches names in
  any case and ignores spaces, so `SECRETS.npm_token`, `secrets . NPM_TOKEN` and
  `secrets[ 'npm_token' ]` are all `ci.secret(NPM_TOKEN)`. Any other use of the
  context is `ci.secret(all)`: `secrets[matrix.name]`, `secrets[format(...)]`,
  `secrets.*`, `toJSON(secrets)`, or `secrets` by itself.
- **A byte-order mark** at the start of a file is ignored, as GitHub and npm do.

### Workspaces

npm, Yarn, pnpm and Bun run a workspace package's install scripts when the root is
installed, so PermLang records each workspace package's scripts too, keyed by its
path (`packages/api/package.json#<package.json>`). The packages are the folders
listed in `package.json`'s `workspaces` (a list, or Yarn's and Bun's
`{ "packages": [...] }`) and in `pnpm-workspace.yaml`'s `packages`. With no
`packages` list, pnpm takes every package in the repository, and so does PermLang.

Folders are matched as the package managers match them: `*`, `?`, `**`, `{a,b}`,
`[abc]`, and `!` to leave folders out; `node_modules` is never searched. A pattern
with syntax PermLang doesn't read (`+(a|b)`) matches any folder name there, so it
can only record more, and an exclusion written with it is ignored. A `workspaces`
or `packages` list PermLang can't read is unverifiable, and every package's scripts
are recorded. pnpm's `package.yaml` is read like `package.json`; a `package.json5`
that isn't plain JSON is unverifiable.

### Known limits

- Steps' `run:` commands aren't recorded.
- A Docker Action built from a `Dockerfile` (`image: Dockerfile`, or a local Action
  with only a Dockerfile) is part of the repository, but the Dockerfile isn't read:
  a base image it pulls by tag (`FROM node:22`) isn't recorded as unpinned.
- Other files that run code during an install aren't recorded: `.npmrc`
  (`script-shell`, `node-options`), `.yarnrc.yml` (plugins, `yarnPath`),
  `.pnpmfile.cjs`, `binding.gyp` (npm runs `node-gyp rebuild` for a package that
  has one), and the `packageManager` field (Corepack downloads that version). Nor
  are pnpm's settings for which dependencies may run install scripts, such as
  `onlyBuiltDependencies`.
- `uses: $/path`, a newer way to name an Action in the same repository that
  GitHub's parser accepts, is read from the repository like `./path`, but recorded
  as unpinned: which commit it runs isn't documented.
- Actions and reusable workflows from other repositories aren't read; pinning them
  to a commit is what keeps them from changing.

**Upgrading from 0.3 or earlier:** there's no grace period. A lock written
before 0.4 fails the check with one error until `permlang lock` rewrites it; see
[upgrading the lock](#upgrading-from-03-or-earlier). 0.4 also reads configuration
it missed before (aliases, secrets written other ways, local Actions, images,
workspace packages), names secrets in upper case, adds a hash to unverifiable
entries, and no longer records secrets mentioned outside an expression or `uses:`
keys that aren't steps or jobs. So the rewritten lock can differ from the old one
here too: review the change before committing it.

## Adapter manifests

A manifest maps a package's functions to capabilities. Keys are
`Container.member`, where the container is the class, interface, or type alias
that declares the function. Use `Container()` for a call signature and a bare
`name` for a top-level function. `{host:N}` and `{arg:N}` fill a scope from
argument N:

```json
{
  "permlang": 1,
  "package": "stripe",
  "defines": ["payments.charge", "payments.refund"],
  "default": ["net(api.stripe.com)"],
  "functions": {
    "RefundResource.create": ["payments.refund", "net(api.stripe.com)"],
    "WebhookObject.constructEvent": []
  }
}
```

`{host:N}` reads a URL, a template with a literal host, `new URL(...)`, or an
options object whose `url`, `hostname`, and `host` all name the same host (for
the `net` and `tls` modules, the options' `host`, as Node reads it). A spread,
an accessor, a computed key, or a `socketPath`, `lookup`, or `createConnection`
option makes it unknown. `{host:N+}` reads argument N the way Node's
`http.request(input, options)` does: `hostname` before `host`, no `url` option,
and an options argument after a URL can replace its host with `hostname`. A
placeholder that can't be read gives the bare capability, so the call needs,
say, `net`.

`default` applies to every other method in the package (not constructors). An
empty list maps a function to nothing. Keys must match how the package's types
declare the function: `process.kill` is declared on the `Process` interface, so
its key is `Process.kill`, not `kill`. Add your own adapters in
`permlang.config.json`; they take precedence over the built-in ones:

```json
{ "adapters": ["./permlang/adapters/acme-sms.json"] }
```

Two more placeholders cover hosts set in options: `{host:N+}` is argument N's
host unless a later options argument sets another (Node's
`http.request(url, { hostname })`), and `{host:N?}` counts only when argument N
can set a host (Stripe's `new Stripe(key, { host })`; a config that doesn't name
one adds nothing). For database clients, PermLang's own detection applies first,
and adapters add to it.

### Packages without an adapter

PermLang can't see what a package does unless an adapter describes it, so a
package with no adapter is trusted. It's never trusted silently: every report
lists these packages with their call counts, and each one gets a warning
(PERM006) at its first call. Set `"unmapped"` in `permlang.config.json`, or pass
`--unmapped`, to change that:

| Policy | Effect |
| --- | --- |
| `warn` (default) | One warning per package. |
| `error` | One error per package: every package must be mapped or declared pure. |
| `trust` | No diagnostic. The report still lists them. |

A package that touches nothing PermLang tracks is declared pure with an adapter
whose `default` is `[]`. [`adapters/pure.json`](../adapters/pure.json) does this for
Node's pure built-ins and common libraries (zod, date-fns, React, ...).

Built-in adapters cover axios, Stripe, nodemailer, `node-fetch`, `undici`, Redis
(`redis`, `ioredis`), Kafka, Bull/BullMQ, ClickHouse, AI SDKs (`ai`, `openai`,
`@anthropic-ai/sdk`, ...), MCP clients, several web APIs, `@nestjs/config`,
`maxmind`, `tar`, and the Node modules that carry capabilities (`process`,
`cluster`, `inspector`, `module`, `crypto`'s `setEngine`, and the rest). In
projects without lib.dom, Node's web globals (`Headers`, `Request`, `WebSocket`,
...) are typed by `undici-types`, which has its own adapter. Where an
adapter can't know a service's hosts, it uses bare `net`. PermLang runs itself
with `"unmapped": "error"` and a team adapter for ts-morph (see
[`permlang.config.json`](../permlang.config.json)).

Stripe's calls go to `api.stripe.com`, except file uploads and quote PDFs
(`files.stripe.com`), OAuth (`connect.stripe.com`), meter event streams
(`meter-events.stripe.com`), and `rawRequest` (any of the four); a client created
with a `host` in its config also needs that host. `tar` extraction writes files
(tar 7's typings give every command one shape, so listing counts as a write too).
Some otherwise pure libraries have a few functions that aren't: cheerio's
`fromURL`, rxjs's `ajax`, `fromFetch`, and `webSocket`, and react-dom's resource
hints (`preload`, `preconnect`, ...) reach the network; react-dom's `preinit` and
`preinitModule` also run the script they load, and lodash's `template` compiles
its text into code, so those three are unverifiable.

## Strictness levels

Set `"strictness"` in `permlang.config.json`, or pass `--strictness`:

| Level | What fails |
| --- | --- |
| `sketch` | Only what you ask for explicitly: access the lock file doesn't record (`PERM005`), flow rules (`PERM009`), and `"unmapped": "error"` or `"tools": "error"`. Rules about `@perm` annotations are reported as warnings, and every function's permissions are inferred. Start here on an existing codebase. |
| `development` (default) | Annotated functions that exceed their `@perm`, invalid annotations, unverifiable code, and exported functions or top-level code without `@perm`. |
| `production` | All of the above, plus any function (private helpers too) that reaches something without being covered by function- or module-level `@perm`. |

## The lock file and the permission diff

`permlang lock` writes `permlang.lock.json`: what every function can reach, what
every workflow, Action, and `package.json` script grants, and which files the check
ran on and with which settings. Commit it. From then on:

- **`permlang check` fails when the code and the lock differ in any way**
  (PERM005), at every strictness level, sketch included:
  - The code reaches something the lock doesn't record. New access can't land
    without the lock changing, so it always shows up in review. The error points
    at the line that reaches the new access, such as the new `fetch` or the call
    into a helper that makes it.
  - The lock records something the code doesn't reach. Otherwise a pull request
    could approve access in advance by editing only the lock, for a later change
    to use without showing up. The error points at the lock's own line.
  - A `@perm-unsafe` override is new, gone, or has a different reason.
  - The check ran on other files, or with other settings, than the lock records
    (see below).

  To approve any of these, run `permlang lock` and commit the change, so
  reviewers see it.
- **`permlang diff <base-ref> [paths...]` shows what changed since `base-ref`**, one row per
  new capability, with where it happens and which functions can now reach it:

  | New access | Where it happens | Now reachable from |
  | --- | --- | --- |
  | `+ net(api.data-broker.io)` | `scoreLead`<br>axios.post("https://api.data-broker.io/v2/enrich", ...) | `scoreLead`, `handleLead` |

  The diff compares `base-ref`'s lock with what the code reaches now, not only
  with the lock file on disk. With `--head <ref>`, it compares two committed lock
  files. Above the table, it says whatever makes it incomplete or the check fail:
  - **Not approved yet**, when the code and the lock file don't match. Access the
    lock records but the code doesn't reach is listed under its own heading.
  - When the change deletes the lock file, or an older PermLang wrote it.
  - When the code couldn't be analyzed (an invalid setting, say). The diff then
    shows only what the lock files record, says so, and never says "No permission
    changes".
  - When the base commit has no lock file, so everything is listed as new.

  Changes to what's checked, or how strictly, are listed under **Check settings
  changed**, such as `unmapped: now trust, was warn`, or an `exclude` added to
  tsconfig.json. New and changed `@perm-unsafe` reasons are listed with the old
  reason.

  The diff also lists **new dependencies**: packages the change adds to
  `./package.json`, in `dependencies`, `devDependencies`, `optionalDependencies`,
  or `peerDependencies`. For each one, it says what PermLang sees (checked by an
  adapter, declared pure, detected directly, or **not checked** because it has no
  adapter) and lists its `preinstall`, `install`, and `postinstall` scripts when
  it's installed. It also lists a package already there that the change now
  installs from somewhere other than the registry: an alias
  (`"lodash": "npm:evil-lodash@1.0.0"`), a URL, git, or a local folder or tarball.
  Its name, and so its adapter, stay the same while its code changes. These are
  there for review: they don't fail the check, although calls into a package with
  no adapter get a `PERM006` warning.

`--format markdown` produces the pull-request comment. Text from the code is
escaped so it can't change the comment: it can't break out of code formatting or
a table, hide rows in an HTML comment, mention people (`@name`), or link issues,
commits, URLs, or emoji (an invisible zero-width space breaks those). The
comment stays under GitHub's length limit: a row names at most 20 functions,
and when the comment would still be too long, it's cut short from the end, the
new-access table first in line to stay, with a note saying how much is left out.
If the diff can't be computed at all (the base commit can't be read, say),
`--format markdown` still prints a comment that says so, and the command exits 2.

`--format json` is for tools, and includes `unrecorded` (where the code and the
lock file differ, or `null`), `unsafeChanged`, `analysisError` (or `null`),
`lockDeleted`, `baseLockMissing`, and `dependencies` (each with its `section`, and
`change`: `added` or `source`).

The text output of `check`, `lock`, and `diff` escapes line breaks and control
characters in anything from the code (`\n`, `\u001b`), so a string in the code
can't print a line of its own, which GitHub Actions would obey as a workflow
command, or drive the terminal.

The check compares against `./permlang.lock.json` whenever it exists. When
checking other files from the same folder (like the fixtures here), pass
`--no-lock`.

### What the lock records

```json
{
  "permlang": 2,
  "functions": {
    ".github/workflows/ci.yml#<ci.yml>": ["ci.permission(contents: read)", "ci.trigger(pull_request)"],
    "permlang.config.json#<permlang.config.json>": [
      "permlang.files(src)",
      "permlang.strictness(development)",
      "permlang.tools(warn)",
      "permlang.unmapped(warn)"
    ],
    "src/leads.ts#handleLead": ["db.write(lead)", "email.send"]
  },
  "unsafe": { "src/render.ts#compile": "template compiler; trusted input" }
}
```

Keys are `<path>#<function>`, with the path relative to the lock file. Several
functions of the same name in one file get `#2`, `#3`, in source order, and
`@perm-unsafe` overrides are keyed the same way. A `#` or `%` in a file's name is
written `%23` or `%25`, so the first `#` always ends the path. Functions that
reach nothing are left out.

The settings are an entry keyed by the config file (`permlang.config.json`, or
the `--config` file), whether or not it exists:

| Capability | What it records |
| --- | --- |
| `permlang.files(path)`, or `permlang.project(tsconfig.json)` | The files checked: the paths given (`src` when none are given and there's no `./tsconfig.json`), or the TypeScript project given with `--project` or found as `./tsconfig.json`. |
| `permlang.strictness(level)`, `permlang.unmapped(policy)`, `permlang.tools(policy)` | The settings in effect: a command-line option (or the Action's `strictness` input), else `permlang.config.json`, else the default. |
| `permlang.flow(from -> to)` | Each [flow rule](#data-flow-rules). |
| `permlang.adapter(path sha256:...)` | Each adapter manifest, from the config file or `--adapter`, with the first 16 hex digits of the SHA-256 of its content. The content is hashed as parsed JSON, so line endings and formatting don't change it. |

When the files come from a TypeScript project, its config is an entry too: its
`include`, `exclude`, and `files` after following `extends` (TypeScript's
defaults when they aren't set: everything included, the output folders
excluded), and the compiler options that decide what imports and globals resolve
to: `baseUrl`, `paths`, `rootDirs`, `typeRoots`, `types`, `lib`, `noLib`,
`allowJs`, `moduleResolution`, `customConditions`, and `moduleSuffixes`.
A tsconfig.json that can't be parsed, or that extends a file that isn't there, is
an error (exit code 2).

So narrowing `include`, lowering `strictness`, trusting packages with no adapter,
adding an adapter that declares a package pure, dropping a flow rule, or checking
other paths all fail the check until `permlang lock` records them, and show in
the pull-request comment.

**Check with the paths and options the lock was written with.** A check of
other files fails with one error that says which files each was for:

```
permlang.config.json:1:1 error PERM005: This check ran on --project tsconfig.json, but permlang.lock.json was written for src.
```

A check with other settings fails with an error for each one:

```
permlang.config.json:1:1 error PERM005: The check runs with unmapped: trust (from --unmapped), but permlang.lock.json records unmapped: warn.
```

To change them, run `permlang lock` with the new paths and options, and commit
the change. To try other settings without the lock, add `--no-lock`.

**A missing lock file.** With `--require-lock`, a missing lock is an error
(PERM005); the GitHub Action passes it when the pull request's base commit has
the lock. A `--lock <file>` that doesn't exist is a usage error (exit code 2), so
a mistyped path can't turn the comparison off. `--no-lock` with `--require-lock`
is a usage error too. Without any of these, a check with no lock file checks
only annotations.

#### Upgrading from 0.3 or earlier

Locks written before 0.4 are format 1, which recorded no settings. `permlang
check` fails on one with a single error:

```
permlang.lock.json:1:1 error PERM005: permlang.lock.json was written by an older PermLang (lock format 1), which recorded less than this version checks.
  -> run `permlang lock` once to update it, and commit the change.
```

Run `permlang lock` once, with the paths and options your check uses, and commit
the result. Nothing in a pull request can make the check lenient instead: there's
no grace period. `permlang lock` also replaces a lock it can't read at all (one
with merge-conflict markers, say), with a warning to review all of it.

## GitHub Action

```yaml
# .github/workflows/permlang.yml
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  permissions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
      - run: npm ci --ignore-scripts   # or pnpm / yarn; see below
      - uses: PermLang/permlang@v0
        with:
          args: src            # or --project tsconfig.json
```

**Install dependencies before the Action.** PermLang reads code through the
TypeScript compiler, so it needs your dependencies' types, `@types/node` above
all. Without them, file, process, and environment access are invisible, and the
check reports `PERM007` warnings instead of what the code does.
`permlang init --workflow` writes this step for npm, pnpm, or yarn, based on
your lockfile. Install scripts aren't needed for types; if you generate code,
such as with `prisma generate`, run that too.

What `init --workflow` writes:

- **pnpm and Yarn** come through Corepack, which the workflow installs from npm
  first (`npm install --global corepack@latest`), since Node 25 and later no
  longer include it. Yarn 2 and later (a `.yarnrc.yml`, or a Yarn 2 lockfile)
  install with `--immutable --mode=skip-build`; Yarn 1 with
  `--frozen-lockfile --ignore-scripts`.
- **Triggers**: pull requests, merge queues (`merge_group`), and pushes to the
  repository's default branch (from `origin`'s HEAD, else `main`).
- **In a monorepo package**, run `init` in the package: the workflow goes in
  the repository's `.github/workflows/`, named after the package
  (`permlang-packages-api.yml`), with `working-directory` set to it.
  Dependencies install at the repository root, where the lockfile is.
- **Paths** are written with forward slashes. A path with a space can't be
  passed in the Action's `args`, so `init` refuses it; list such files in a
  `tsconfig.json` and use `--project`.

`init` keeps an existing config, workflow, or lock. It writes the workflow
before the lock, so the lock records it and the first pull request passes.

The Action runs `permlang check`, fails the build on errors, and posts the
permission diff as a pull-request comment, updating it on later pushes. Each
problem also appears as an annotation on its line in the pull request's
**Files changed** tab, and in the check's summary. GitHub shows up to 10 error
and 10 warning annotations per step; the full list is in the log and the
comment. This repository runs it on itself (see
`.github/workflows/permlang.yml` and `permlang.lock.json`).

`@v0` follows the latest 0.x release. A minor release (0.2, 0.3, ...) can
detect more and fail builds that passed before; the [changelog](../CHANGELOG.md)
says when. To upgrade on your own schedule, pin an exact release instead. The
safest pin is the release's commit, since a tag can be moved
(`PermLang/permlang@<commit-sha> # v0.3.3`); Dependabot keeps such pins up to
date. See the [releases](https://github.com/PermLang/PermLang/releases).

**Code scanning.** Set `sarif: true` to also upload the findings to GitHub code
scanning, where they appear in the repository's **Security** tab next to
CodeQL's, and close on their own once fixed. The workflow needs
`security-events: write` in its `permissions:`. The upload is best effort: on a
pull request from a fork, whose token is read-only, it's skipped and the check
still runs. Each `working-directory` uploads under its own category
(`permlang`, or `permlang/<folder>`), so runs for several folders don't replace
each other's alerts.

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write
# ...
      - uses: PermLang/permlang@v0
        with:
          args: src
          sarif: true
```

| Input | Default | Meaning |
| --- | --- | --- |
| `args` | | Arguments for `permlang check`: source paths, or `--project tsconfig.json`. |
| `strictness` | | `sketch`, `development`, or `production`. Overrides `permlang.config.json`. |
| `working-directory` | `.` | Where the code, `permlang.config.json`, and `permlang.lock.json` are. |
| `comment` | `true` | Post the permission diff as a pull-request comment. |
| `sarif` | `false` | Also upload the findings to code scanning. |
| `github-token` | `github.token` | Token for the comment. |

| Output | Meaning |
| --- | --- |
| `exit-code` | The exit code of `permlang check`: `0` no errors, `1` permission errors, `2` anything else (a usage or configuration error, a file that can't be read or written, or an internal error). |

**The inputs and the lock file.** `args` and `strictness` change what's checked,
so the lock file records them, as it does `permlang.config.json`: a pull request
that changes them in its workflow fails the check until `permlang lock` is run
with the same arguments and options, and committed. For a workflow with
`args: src` and `strictness: sketch`, that's `npx permlang lock src --strictness sketch`.

**A deleted lock file.** On pull requests and merge-queue entries, the Action
fetches the base commit first. When the base has the lock file
(`permlang.lock.json`, or the file `--lock` names in `args`), the check runs with
`--require-lock`, so deleting the lock fails it, and the comment says the pull
request deletes it. When the base commit can't be fetched, the lock is required
anyway, with a warning. `--no-lock` in `args` then stops the check with a usage
error.

**The comment.** The Action updates its own comment on each push. It finds the
comment by its first line, a marker that names the `working-directory` when it
isn't the repository root (so runs for several folders each keep their own), and
by the account of the token that posted it: `github-actions[bot]` for the default
token, or a personal token's owner. It never edits a comment from another
account. The comment's text goes to GitHub in a file, and stays under GitHub's
length limit. If its comment can't be updated, the step fails, since the old
comment would go on looking current. If the diff can't be computed, the comment
says so instead. Other problems (fetching the base commit, posting a first
comment without `pull-requests: write`) are warnings, and the diff is always in
the job summary. A pull request from a fork gets the diff in the job summary
only, since its token is read-only.

**Node.** The Action runs PermLang on Node 22, from the runner's tool cache, by
its full path, so the Node your later steps use doesn't change. On a runner
without Node 22 in its tool cache (some self-hosted runners), it installs it
with `actions/setup-node` (with its package-manager cache turned off), which
does put it first on the PATH for later steps.

## Usage

```bash
npm install
npm test                                           # conformance + unit tests
npm run permlang -- init src                        # set up a project: sketch config + first lock
npm run permlang -- check fixtures/m1 --no-lock    # run the checker from source
npm run permlang -- check src --json               # JSON report of declared vs. actual permissions
npm run permlang -- check src --github-annotations # also print GitHub Actions annotations (the Action does this)
npm run permlang -- check src --sarif out.sarif    # also write the findings as SARIF, for code scanning
npm run permlang -- lock src                       # write permlang.lock.json
npm run permlang -- check src --require-lock       # also fail when permlang.lock.json is missing
npm run permlang -- diff origin/main               # permission changes since main
npm run permlang -- spec src --spec x.perm        # check a .perm spec against the code
npm run permlang -- --version                      # the installed version
npm run permlang -- check --help                   # usage (any command)
```

Exit codes: `0` no errors; `1` permission errors, and nothing else; `2`
anything else: a usage or configuration error, a file that can't be read or
written, or an internal error. An internal error prints the error and where it
happened, to [report](https://github.com/PermLang/PermLang/issues).

With `--json`, `--github-annotations` prints the annotations on standard error,
so standard output stays valid JSON. GitHub Actions reads both.

## Specs (phase 2 groundwork)

A `.perm` spec describes one piece of logic in one file: rules, examples, and the
permissions its implementation may use.

```
perm process_refund(order: Order, reason: Text) -> RefundResult
  implements: src/refunds.ts#processRefund
  must:
    never refund more than the amount paid
  examples:
    order(paid: $120, 5 days ago) -> refunded($120)
  perms:
    db.read(orders), db.write(refunds), payments.refund
```

`permlang spec src` checks each spec's `perms:` against what the implementation
actually reaches. It fails when the implementation reaches code it can't see (an
import whose types can't be found), and when the `implements:` name matches more
than one function. Rules and examples are parsed and reported as not yet verified.
See [docs/spec-format.md](spec-format.md).

## Real-world trial

[docs/trial-2026-09.md](trial-2026-09.md): PermLang on Umami (1,372 files, 22 s)
and Ghostfolio's API (524 files, 9 s). It found and fixed four false-positive
classes and one false-negative class (Prisma clients built with `$extends`),
found no false positives in a spot check of its network, process, and file-write
findings, and identified the main remaining false negative: SDKs without
adapters. Run `prisma generate` before PermLang in CI, or database access is
invisible.

## Development

Tests come first. Each detection rule gets passing and failing fixtures
under `fixtures/`. A fixture marks each line that must produce a diagnostic:

```ts
writeFileSync("./data/out.json", data); // expect: error PERM001 fs.write(./data/out.json)
```

Files in `pass/` must produce no diagnostics. Files in `fail/` must produce
exactly the expected ones. A fixture can be a folder of files that import each
other. Every fixture file must be a module (have an import or export).

```
src/capability.ts   vocabulary, parsing, and coverage rules
src/annotations.ts  reading @perm tags from JSDoc and @module comments
src/adapters.ts     adapter manifests: loading, validation, matching
src/detect/         direct uses: fetch, fs, env, browser and Node globals, Prisma, Drizzle, SQL, adapter-mapped calls, values, module loads, unverifiable code
src/dispatch.ts     implementations reachable through interfaces, type aliases, and base classes
src/units.ts        functions, methods, and files that permissions attach to
src/graph.ts        the call graph and propagation along it
src/walk.ts         walking syntax trees without recursion, and finding positions in them
src/load.ts         building the ts-morph project, setting aside files that can't be parsed
src/unmapped.ts     packages with no adapter, and imports (and `process`) with no types
src/unseen.ts       code a function reaches that has no types, for checking specs
src/project-files.ts workflows, Actions, and package.json scripts, as lock entries
src/workflow-files.ts what a workflow or Action grants, read where GitHub reads it
src/yaml-nodes.ts   YAML as GitHub reads it: anchors, aliases, merge keys
src/ci-expressions.ts GitHub expressions: the secrets they read
src/package-files.ts package.json scripts, and which folders are workspace packages
src/tools.ts        tool registrations for AI models, their handlers, and what those reach
src/flows.ts        data-flow rules: parsing, and finding functions that break them
src/deps.ts         new dependencies in a change
src/check.ts        comparing declared vs. actual per unit
src/lock.ts         permlang.lock.json: build, read, compare
src/settings.ts     what the check runs with (config, options, files), as lock entries
src/diff.ts         the permission diff, as text or a pull-request comment
src/report.ts       text, JSON, GitHub annotation, and SARIF output
src/main.ts         the permlang command: its subcommands and options
src/cli.ts          the executable that runs it
src/index.ts        the library API
src/spec/           .perm specs: parsing and checking
```

## Prior art

PermLang is a TypeScript implementation of proven ideas. It builds on:

- **Capslock** (Google) and **capcheck** for Go: transitive capability analysis, lock files, and CI gating.
- **efflux** and **libgaze** for Python: declared effects, call-graph checking, and a focus on AI-assisted code.
- **Cackle** for Rust: per-dependency permissions for net, fs, and process.
- **LavaMoat**, **Socket**, and **reachscan** in the JavaScript ecosystem.
- **Bock**, whose strictness levels PermLang's `sketch` / `development` / `production` modes follow.
- Effect systems in **Koka**, **Unison**, **Flix**, **E**, **Pony**, and **Austral**, and the lessons of
  .NET Code Access Security and the Java SecurityManager, which PermLang must stay simpler than.
