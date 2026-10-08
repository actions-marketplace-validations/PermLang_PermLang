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
- **The built-in capabilities.**
  - `env`: any expression typed `NodeJS.ProcessEnv`, so `process.env.KEY`,
    `process.env["KEY"]`, destructuring, `"KEY" in process.env`, and aliases
    (`const env = process.env; env.KEY`), and patterns that take the
    environment out of what holds it (`const { env: { KEY } } = process`,
    `const { process: { env: { KEY } } } = globalThis`,
    `({ env: { KEY: k } } = process)`, a parameter
    `({ env: { KEY } }: NodeJS.Process)`). Spreading or enumerating the
    environment, a rest element, or a computed key needs bare `env`.
    `process.env` (and `(process as any).env`) is
    read the same way without Node's types, or with a project's own
    `declare const process`, also as `globalThis.process.env`,
    `global.process.env`, `process["env"]`, or through `const p = process`,
    `const { env } = process`, or `const { process: { env } } = globalThis`,
    whose uses are followed (an untyped
    `const env = process.env` reads every variable); a `process`
    that doesn't resolve also gets a PERM007 warning, since its other APIs
    can't be checked. `import.meta.env.KEY` (Vite, Astro, and others) is
    `env(KEY)`, also as `import.meta["env"]`, through `const m = import.meta`,
    or destructured (`const { env } = import.meta`), except what Vite sets
    itself (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`).
    `process.loadEnvFile(path)` needs `env` and `fs.read(path)`
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
    `hostname`. `tls.connect(port, host, options)` merges the options over the
    host argument, so their `host` wins: options that set a different one (or
    may, with a spread or computed key) need bare `net`. `http2.connect(url,
    options)` hands its options to `net` or `tls` the same way, so a `host`,
    `path`, `socket`, `lookup`, or `createConnection` there, or options that
    aren't written out, need bare `net`. An `http` / `https` request's `agent`
    makes the connection, so any agent other than none (`false`, `undefined`) or
    Node's own `new http.Agent({...})` / `new https.Agent({...})` without a
    spread or redirecting option (written in place, or held by a `const` the
    program never changes) needs bare `net`: a subclass or an agent passed in
    could connect anywhere. `fetch`'s `dispatcher` option (Node's undici agent)
    does the same, so options that set one, may set one, or aren't written out
    where they're used need bare `net`; ordinary written-out options (`method`,
    `headers`, `body`, ...) keep the URL's host. Other libraries' options must
    name one host in all of `url`, `hostname`, and `host`. A spread, an
    accessor, a computed key, or a
    `socketPath`, `lookup`, or `createConnection` option (or a `path` for `net`
    and `tls`) could send the connection anywhere, so it needs bare `net`. So do
    options that aren't written out where they're used (a variable, even one that
    may be `undefined`), and a first argument to `net.connect` or `tls.connect`
    that isn't a port number or written-out options. A callback where options
    could be (`net.connect(port, host, onConnect)`) isn't options.
  - `fs.read` / `fs.write`: `readFile` with a writing `flag` option, and
    `createReadStream` (or `new fs.ReadStream`) with a writing `flags` option
    (`"w"`, `"a+"`, or one that can't be read), write the file. As Node does,
    each reads only its own name and ignores the other (`readFile`'s `flags`, a
    stream's `flag`). Used as values, they could be called with any flags, as
    `open` can.
    `new fs.Utf8Stream({ dest })`, `ReadStream`, and `WriteStream` open their
    path. `fchmod`, `fchown`, and `futimes` (and a `FileHandle`'s `chmod`,
    `chown`, and `utimes`) change a file however it was opened, so they need
    `fs.write`. `process.chdir(dir)` needs `fs.read(dir)` and `fs.write(dir)`,
    because every relative path the program uses afterwards resolves inside
    `dir`. `process.report.writeReport(file)` needs `fs.write(file)`, and
    `module.enableCompileCache(dir)` needs `fs.read(dir)` and `fs.write(dir)`
    (bare when they're called without a literal path).
  - `db`: **Prisma**. The table is the
    model's accessor name: `prisma.lead.create()` needs `db.write(lead)`. Raw
    queries need bare `db.read` and `db.write`: SQL (`$queryRaw`, `$executeRaw`,
    ...), `$runCommandRaw`, and a model's `findRaw` and `aggregateRaw` (MongoDB),
    whose filters and pipelines can name other collections (`$lookup`, `$out`).
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
    bare `db.read` (and `db.write` in `data`). So does a method passed along as a
    value (`ids.map(prisma.lead.findMany)`) or called through `.call`, `.apply`, or
    `.bind`, whose arguments can't be read. An extended client's (`$extends`)
    operations name their model only where they're called on one
    (`client.lead.findMany(...)`); reached any other way, they could be any
    operation of any model, and a fluent step (`.owner`) could read any related
    table. So could a model chosen at run time, with a key that
    isn't one literal (`prisma[model].findMany()`, `(prisma as any)[name]`): bare
    `db.read` and `db.write` where it's chosen. A query extension's `query`
    (`$extends({ query: { lead: { findMany({ args, query }) {...} } } })`) runs the
    operation it intercepts: `query({ ...args, include: { owner: true } })` there is
    checked like `prisma.lead.findMany(...)` with those arguments, in the
    extension's callback. One for `$allModels` or `$allOperations`, one passed
    along, and `next()` in older clients' `$use` middleware could run any query.
    Relations are read from the client generated by Prisma 5 or later; with an
    older client, any argument that could name one needs bare `db.read`, and so
    does a fluent API step (`.owner()`). Prisma is recognized by its package and its
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
    definition, and other substitutions are values. `sql.raw("...")` and
    `new StringChunk("...")` are read the same way. With text PermLang can't read,
    they could touch any table, as can a fragment calling a function it doesn't
    know, SQL put together from pieces (`new SQL([...])`, `sql.fromList([...])`),
    and an object of the project's own with a `getSQL()` method, substituted into
    a fragment or passed to a query: drizzle pastes in whatever SQL that returns.
    SQL that a schema definition holds for the database (a column default or
    generated column, a check, an index condition, a view, a policy) reaches it
    through migrations, not a query, so it isn't counted where it's written. Read
    back out of the schema object (`check(...).value`, `pgPolicy(...).using`,
    `leads.score.default`, or destructured), it could go into a query, so it could
    touch any table. A column's `$defaultFn` and `$onUpdateFn` (and `$default`,
    `$onUpdate`) run when drizzle builds a statement, which then holds the SQL they
    return: every insert into the table is charged with the defaults' SQL and the
    update functions', and every update with the update functions'. A function
    written elsewhere (`$defaultFn(makeDefault)`) is judged by its return type: one
    that could return SQL could read any table. For an insert or update into a
    table PermLang can't find, or whose columns it can't all see (spread from
    something other than a `const` or a project function that returns them, or
    16 or more groups of them), that SQL could read any table: bare `db.read`.
  - `db`: **raw SQL clients** (`pg`, `mysql2`, `better-sqlite3`, `sqlite3`,
    `postgres`, `@neondatabase/serverless`, `@vercel/postgres`, and Node's own
    `node:sqlite`). When the query
    is literal text, its tables are read out of it: `SELECT ... FROM leads JOIN
    teams` needs `db.read(leads), db.read(teams)`. Tagged templates (`` sql`...` ``,
    and a `node:sqlite` tag store's `` store.all`...` ``)
    count, because their substitutions are bound parameters, unless a substitution
    is itself SQL (a postgres.js fragment or `sql(name)` helper). The reader fails
    closed: it names tables only for a single `SELECT`, `INSERT`, `UPDATE`, or
    `DELETE` it fully understands. Anything else (`WITH`, `UNION`, DDL, `COPY`,
    `PRAGMA`, more than one statement) can touch any table, as can text that
    databases read differently (MySQL's `--` with no space after it, backslashes,
    executable comments such as `/*! ... */`, and SQLite's `[...]` names and
    Tcl-style variables such as `:a(...)`, which run to the first `]` or `)` whatever
    is between), a function it doesn't know to be harmless (including `lower` called
    through a schema, `evil.lower(x)`, or a quoted name, and a call right after a
    placeholder, such as `@setval(...)`, which Postgres reads as the operator `@` and
    a call), a parenthesized list after an `INSERT` table that isn't a list of
    columns, a quoted name it can't report as written (`"audit.log"`), and SQL nested
    more than 64 levels deep. So can SQL built with string concatenation or a
    template passed to `query()`; a config object (`{ text }`, `{ sql }`) with a
    spread, a computed key, or the SQL named twice, any of which can replace the
    text; and a tag called as a function with an array made to look like a
    template's strings. These need bare `db.read` and `db.write`. So does a mysql2
    `query()` given a value mysql2 might not escape as data: `query()` fills in
    values itself, by pasting each one into the text, and pastes a value's
    `toSqlString()` (what `mysql.raw()` returns) in as SQL. A value is read as
    written or by its type, and only a string, number, boolean, `null`, date, or
    buffer, or an array, a record (`Record<string, string>`), or an object literal
    of those, is sure to be data: one typed as an interface or object type,
    `object`, `unknown`, `any`, or a generic could have that method, whatever its
    type lists, and so could one cast to a plain type where it's passed. So does a
    `query()` with values and a placeholder inside a string, quoted name, or
    comment, since older mysql2 versions fill those in too and a value pasted there
    can end the string. (`execute()` and prepared statements bind values on the
    server, so neither rule applies to them.) Neon's query function called with SQL
    text (before 1.0) is read like `query()`. Any client method PermLang doesn't
    know needs bare `db.read` and `db.write` too, so new APIs can't pass silently;
    postgres.js's query modifiers (`.values()`, `.cursor()`, `.describe()`, ...),
    mysql2's `.promise()`, and a prepared statement's methods (mysql2's, sqlite3's,
    and `node:sqlite`'s) touch nothing beyond the query they belong to. A `?`
    placeholder is read as MySQL and SQLite read it, on its own (SQLite's `?12`
    takes digits too), so in `?FROM secrets` the word after it is the keyword
    `FROM`. Schema-qualified names are declared as written (`db.read(public.users)`).
- **Adapter manifests.** JSON files mapping a library's functions to
  capabilities, including app-level ones such as `payments.refund`. Built-in
  adapters in [`adapters/`](../adapters) cover HTTP clients, Stripe, email, Redis,
  Kafka, queues, AI SDKs, and more (see [below](#adapter-manifests)). Library
  calls resolve by signature, so aliasing a method (`const post = axios.post`)
  doesn't hide it.
- **Escape hatch.** `@perm-unsafe reason:"..."` suppresses one function's
  own checks. Every use is listed in the report. Callers still have to cover
  what the function reaches. It accepts the function's unverifiable code for
  annotations only: an AI tool that calls it still reaches that code
  (`PERM008`), and so does a function that hands it a secret a flow rule
  protects (`PERM009`). A reviewed `eval` still runs whatever it's given.
- **Adversarial coverage.** Tricks that try to hide access are caught:
  - capability functions used as values: `urls.map(fetch)`, `promisify(exec)`,
    `paths.forEach(unlinkSync)`, `{ fetch }`, also inside what a module exports
    (`export default [execSync]`, `export default { pick: () => execSync }`;
    `export default fetch` on its own just exports the function, and calls
    through the import are checked). `send.call(thisArg, url)`,
    `send.apply(thisArg, [url])`, `Reflect.apply(send, thisArg, [url])`, and
    `send.bind(thisArg, url)` (which fixes `url` for every later call) are
    checked as calls, with their arguments. Calls through a `const` alias resolve
    to the original; the alias used as a value
    (`const run = execSync; run.call(null, cmd)`, `Reflect.apply(run, ...)`,
    `urls.map(get)` with `const get = fetch`) is a use of what it holds, and so
    is a name destructured from a module, a global, or a parameter
    (`const { execSync: run } = cp`, `const { fetch } = globalThis`,
    `const { promises: { writeFile } } = fs`, `({ exec }: typeof cp) => ...`).
    A chain of more than 32 aliases is unverifiable. A value whose code isn't in
    sight is judged by its type, as is an element destructured from an array
    (`const [run] = runners`): `require` used as a value
    (`require.call(null, name)`, `["x"].map(require)`, `load(require)`), or what
    `createRequire()` returns, is unverifiable; `require.resolve()`,
    `require.main`, `require.cache`, and `typeof require` aren't uses. Testing
    whether a function exists (`if (globalThis.fetch)`, `!WebSocket`,
    `Boolean(globalThis.fetch)`, `x instanceof WebSocket`,
    `if (ready && window.WebSocket)`) isn't a use, but
    picking one with `&&`, `||`, or `??` outside a condition
    (`const WS = window.WebSocket || Fallback`) is;
  - capability classes reached indirectly: through an alias
    (`const WS = WebSocket`), a subclass, `super(url)`, a `typeof WebSocket`
    parameter, or `Reflect.construct(WebSocket, ...)`;
  - browser APIs in indirect forms: `navigator.sendBeacon.call(...)`,
    `XMLHttpRequest.prototype.open.call(...)`, `window.setTimeout("code")`,
    `Reflect.apply(setTimeout, window, ["code"])`, `self.importScripts(url)`;
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
  an error in annotated functions: `eval`, `new Function`, `setTimeout("code")`
  (and, in a program with lib.dom's timers, a handler that may be a string, such
  as one typed `any`, `unknown`, or `TimerHandler`, and a timer used as a value
  that may later be given one, as in `codes.forEach(setTimeout)`; a timer given
  only functions, Node's `promisify(setTimeout)`, and a copy made with
  `setTimeout.bind(window)` and kept in a `const`, whose calls are checked
  where they're made, run no string),
  `vm`, `new Worker` (Node's, and the browser's `Worker`, `SharedWorker`,
  `importScripts()`, a service worker's `register()`, and a worklet's
  `addModule()`), native code and hooks (`process.dlopen`,
  `crypto.setEngine`, `module.register`, `registerHooks`, `runMain`,
  `module.require`, `new Module()`), the inspector's `Session.post`,
  `require` used as a value, `process.binding()`,
  `process.getBuiltinModule(name)` with a computed name (a
  literal name is like importing the module), computed calls on sensitive
  objects (`fs[method]()`, `globalThis[name]()`) or behind an index signature
  (`table[name]()`), loading a module whose result can't be checked (see
  [loading modules](#loading-modules)), calls into the project's own JavaScript
  through a hand-written `.d.ts`, and a file PermLang couldn't analyze (code
  nested thousands of levels deep, say), whether it's imported or one of its
  functions is called. The only way to accept it is
  `@perm-unsafe`, which also stops it from failing the function's callers'
  annotations. It doesn't hide it from AI tools or flow rules (see the escape
  hatch above).
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
  and its install scripts, and overrides that replace a package's code.
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
- **Callable types and collections of functions.** A call through a callable
  interface or type alias (`interface Runner { (cmd: string): void }`,
  `type Runner = (cmd: string) => void`), or through the function type of a
  collection's entries (`ops.get(name)!(arg)` on a
  `Map<string, (arg: string) => void>`, `handlers.forEach((h) => h(x))` on a
  `Handler[]`, or a `Map` whose type TypeScript inferred from a function in it),
  reaches every function written against that type: one whose type comes from
  it (`const shell: Runner = (cmd) => ...`, an entry of the collection,
  `ops.set("run", (arg) => ...)`), or a named function put where it's expected
  (`ops.set("run", shell)`, `const runners: Runner[] = [shell]`). An anonymous
  function reached this way is named by where it is (`<function at ops.ts:4>`);
  the code around it is charged with what it does, as before. Unlike classes
  and interfaces, a function that merely fits the type isn't counted: nearly
  every function fits a call signature. A function type written for a
  parameter (`function apply(run: (cmd: string) => void)`, or
  `jobs: Array<() => void>`) isn't followed this way: a callback runs as part of
  the code that passes it, which already reaches it. A callable type alias is
  followed wherever it's used, parameters included, so a function that calls
  what it's given through one (`function retry(job: Job)`) reaches every
  function written against that alias, as a call through an interface reaches
  every implementation.
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
| a package declared pure, or data (see below) | nothing |
| a specifier that can't be traced, or a file outside the project (an absolute path, `/opt/x.js` or `C:/x.js` wherever the check runs) | unverifiable |

`data:`, `http:`, `https:`, `blob:` and `file:` specifiers are unverifiable in
every form of import: the code isn't a file in the project. A query or fragment
doesn't make a script an asset (`./evil.js?x=.css` is still `./evil.js`).

Which files are data depends on what loads them:

- **An ES import** (`import`, `export ... from`, or `import()`, in a file
  TypeScript emits as an ES module): a stylesheet, an image, JSON, or another
  asset is data. A bundler loads it as what it is, and Node's ES module loader
  doesn't run it.
- **`require()`**, `import x = require()`, and imports in a file TypeScript
  compiles to CommonJS: only a `.json` file that exists is data. Node runs any
  other file as JavaScript, and adds `.js` to a path that doesn't exist, so
  `require("./theme.css")` runs `./theme.css`, or `./theme.css.js`, and
  `require("./data.json")` runs `./data.json.js` when there's no `./data.json`.
  Such a `require()` is unverifiable (PERM004), and such an import is one whose
  types can't be found (PERM007). The extension must be exactly `.json`:
  `./data.JSON` runs as JavaScript too.

A file is compiled to CommonJS when `"module"` is `commonjs` (or AMD, UMD, or
unset with a target before ES2015), when it's a `.cts` file, or, with `node16`
or later, when its `package.json` doesn't say `"type": "module"`. There,
`import()` stays an ES import. When the check is given paths instead of a
tsconfig.json, files are read with bundler settings (ES modules), so in a
project compiled to CommonJS, check with `--project tsconfig.json` to have its
imports of asset-looking files reported. A `require()` is held to the CommonJS
rule either way.

### Which files are checked

`permlang check src` checks the TypeScript files under `src` (`.ts`, `.tsx`,
`.mts`, `.cts`, outside `node_modules`), and `--project tsconfig.json` checks the
files the tsconfig.json selects. That's where the check starts, not where it
stops: a file of the project's own that a checked file imports (by `import`,
`export ... from`, `import x = require()`, or a literal `import()`) runs with it,
so it's checked too, wherever it is (`../lib/db.ts`, `scripts/telemetry.ts`), and
so is everything it imports. Packages in `node_modules` and declaration files
aren't analyzed: packages go by their adapters (see
[packages without an adapter](#packages-without-an-adapter)), and calls into
JavaScript behind the project's own `.d.ts` are unverifiable.

The lock records each file the check read only because a checked file imports
it, as `permlang.imported(lib/db.ts)`. A pull request that brings code from
outside the paths into the check shows it under **Check settings changed**, and
fails until `permlang lock` records it; so does one that stops importing it.

### Known limits

The aim is to catch the whole adversarial suite, or to document each miss. Misses
are kept as fixtures in
[`fixtures/m4/limits/`](../fixtures/m4/limits) and [`fixtures/m6/limits/`](../fixtures/m6/limits),
and as "known misses" in the adversarial suite
([`test/adversarial.test.ts`](../test/adversarial.test.ts)), which also lists
the harmless code that must stay silent. Each of those tests fails once its miss
is fixed, so they can't go stale. The list below also describes misses that have
no test yet.

- Values typed `any`: nothing called on them can be resolved. Where a global
  object, a capability module, or a database client becomes `any`, the escape
  itself is checked:
  - A member read off a cast is looked up on the original type and reported as
    the access it is: `(globalThis as any).fetch(url)`,
    `(childProcess as any)["exec"](cmd)`, `(process as any).env.KEY`,
    `(globalThis.process as any).env.KEY`, and down a chain of members
    (`(window as any).navigator.sendBeacon(url)`) or into a constructor
    (`new (globalThis as any).WebSocket(url)`). Casts to `Record<string, any>`
    and through `unknown` count too. Database clients are followed this way too:
    a Prisma client or one of its models (`(prisma as any).lead.deleteMany()`),
    a Drizzle database, or a SQL client's pool or connection
    (`(pool as any).query(sql)`).
  - A capability module is any value whose type is one: a namespace or default
    import, `import cp = require(...)`, the result of `await import(...)` or
    `process.getBuiltinModule(...)`, or a module of the project's own that
    re-exports one. One that escapes any other way (stored, passed, or returned
    as `any`; passed on as `unknown`, `object`, `{}`, or a record such as
    `Record<string, unknown>`; listed with `Object.values`, `entries`, or
    `keys`; read or written with a computed key, also by `Reflect.get`; or
    given to a callback parameter typed `any` or `unknown`, as in
    `Promise.resolve(cp).then((m: any) => ...)`; or given as `this` to a function
    of the project's own, as in `run.call(cp)`; copied with a spread,
    `{ ...cp }`; or passed to a parameter of the project's own typed with a type
    parameter or a mapped type, as in `function run<T>(m: T)`,
    `function run<T>(...ms: T[])`, or `function run(m: Partial<typeof cp>)`; or
    passed as an argument the function has no parameter for, which only
    `arguments` reaches) is unverifiable (PERM004).
    Passed to a parameter of its own type (`function run(m: typeof cp)`), it's
    checked through that parameter like the module itself. A module's function
    or class called past a cast returns `any` too, so when what it returns or
    builds reaches a capability (`new (pg as any).Client()`,
    `(module as any).createRequire(file)`), the call is unverifiable.
  - A default import of a capability module that the compiler options give no
    default export (`import cp from "node:child_process"` with
    `allowSyntheticDefaultImports` off, as under `"module": "commonjs"` without
    `esModuleInterop`) is typed `any` by TypeScript, but bundlers and Node still
    hand over the module. A named member (`cp.execSync(...)`) is looked up on the
    module, and any other use (destructuring it, passing it on, exporting it) is
    unverifiable.
  - `const f: any = fetch` counts as using `fetch`, and `declare const require: any`
    and `(require as any)(...)` are still `require`.

  Two things stay unchecked. A global object or database client stored as `any`
  (`const w = window as any; w.fetch(url)`, `const p: any = prisma`), passed on
  as `any` or `unknown`, or read with a computed key isn't followed: those are
  common and almost always harmless (a client handed to a framework's container,
  say), so they aren't reported. (A Prisma model picked with a computed key is
  reported, as described under Prisma above.) And a value that was `any`
  from the start, such as an untyped parameter, has nothing to trace; that
  includes a module handed through a promise or a collection to a named
  function whose parameter is `any` (`Promise.resolve(cp).then(handle)`, with
  `function handle(m: any)`), since only callbacks written in place are
  matched to what they're given. A module that's passed on from somewhere other
  than its own name (an array element or an object's property, as in
  `use(modules[0])`) isn't followed either, nor is an object holding one that's
  then cast (`const holder = { cp }; (holder as any).cp.exec(cmd)`). Imports
  whose types can't be found, including packages shimmed with
  `declare module "x";`, are reported (PERM007), whether reached by `import`,
  `import x = require()`, or a literal `import()`. A default import of a
  package with no adapter that the compiler options give no default export (see
  above) is `any` too, so calls on it aren't listed as calls into the package
  (PERM006); TypeScript itself reports the import as an error (TS1192, TS1259).
- `Proxy` traps, which can return a capability function for any property. A
  handler's traps are entry points (or charged to the function creating the
  `Proxy`), but a call through the `Proxy` isn't linked to them.
- Functions attached after the fact (`obj.m = fn`, reassigning a `let`) aren't
  linked to calls through that property or variable. The top-level code that
  assigns them is still reported.
- A function is linked to calls through a callable type or a collection only
  when it's written against that type (see
  [how calls are followed](#how-calls-are-followed)). Not linked: a function
  that only fits the type, and reaches the call some other way (from outside
  the project, say, or through `any`); a function put in a collection through a
  parameter of a function type of its own
  (`function add(job: () => void) { jobs.set("x", job); }`); and a collection
  with no function type (`new Map()` with no type arguments is a
  `Map<any, any>`, so calls through it can't be resolved at all). The code that
  makes the function is charged with what it does either way. A call through an
  array entry picked by a computed index (`handlers[i]()`) is unverifiable.
  Matching every function that fits instead would link nearly every function:
  any function with no parameters fits `() => void`.
- Implicit calls made inside a library function: `Promise.resolve(x)` calling
  `then`, `Array.from(x)` running an iterator, `String(x)` calling `toString`.
  Written directly (`await x`, `for...of`, `${x}`, `"" + x`), they're caught.
- `as const` objects and enum members are trusted as fixed values, though code
  can change them at runtime. Every reference to one is checked for a write (an
  assignment, `delete`, `++`, or destructuring into a member; a cast; or being
  the first argument of `Object.assign`, `Object.defineProperty`,
  `Object.defineProperties`, `Object.setPrototypeOf`, `Reflect.set`,
  `Reflect.defineProperty`, `Reflect.deleteProperty`, or
  `Reflect.setPrototypeOf`, matched by declaration however they're reached:
  `Object["assign"]`, `const { assign } = Object`, `globalThis.Object.assign`,
  `.call`, `.bind`, `.apply`, `Reflect.apply`, or a spread list of arguments),
  and so is an `as const` object's own method, getter, setter, or `function`
  property (also one of an object nested in it) that writes to `this`. Values
  read from a written object are unknown. A plain exported `const`, enum, or
  `as const` object is also unknown when the object holding the exports is
  written: its namespace (`namespace Api { export const url = ... }` with
  `Object.assign(Api, ...)`), or, in a file compiled to CommonJS (a `.cts` file;
  under node16 or nodenext, one in a package that isn't `"type": "module"`;
  otherwise per the `module` option), the module's `exports` object reached by
  a namespace import or `import x = require()` (`import * as config` with
  `Object.assign(config, ...)`); an ES module's namespace can't be written. An
  object passed to a function that writes to it, or stored in another variable
  first, isn't followed ([`fixtures/m6/limits/constant-written-elsewhere.ts`](../fixtures/m6/limits/constant-written-elsewhere.ts)),
  and neither are a CommonJS module's exports written through `require()`,
  `module.exports`, or a namespace re-exported from another file
  (`export * as config from "./config"`). Treating every such value as unknown
  instead would turn most uses of constants into bare capabilities.

Other gaps, not yet in fixtures:

- Third-party packages without an adapter: what they touch is trusted. They are
  listed in every report and warned about (PERM006; see below).
- A `ProcessEnv` received as a parameter typed as a plain object.
- A library client's options that route a request through something else
  aren't read: axios's `proxy`, `httpAgent`, and `httpsAgent`, node-fetch's
  `agent`, or a `dispatcher` given to the `undici` package's own `request()` or
  `fetch()`. The host is taken from the URL. (Node's `http`, `https`, `http2`,
  `tls`, and the global `fetch` read theirs; see `net` above.) An `http.Agent`
  held by a `const` is trusted unless the program writes to that `const` where
  it's named; one passed to a function that changes it isn't followed.
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
  `allowJs`, as long as the `.d.ts` describes it. Declarations that describe a
  package (`declare module "x"`, or a `.d.ts` in a folder with its own
  `package.json`) are trusted like a package with no adapter: listed and warned
  about (PERM006; see [packages without an adapter](#packages-without-an-adapter)).
  Declarations that describe the runtime (`declare global`, or a `.d.ts` with no
  imports or exports) are trusted without being listed, as what the runtime
  provides: a global function declared there, and defined by a script the page
  or process loads, isn't checked.
- A client prisma-client-js generates into a folder of the project's is covered
  by the Prisma detector, as `@prisma/client` is, and nothing in that folder is
  listed. PermLang recognizes it by what Prisma writes there (its `index.d.ts`
  imports Prisma's runtime as `runtime`; Prisma's header isn't enough), and
  can't tell a real generated client from a forged one: a folder with a
  `package.json`, a `.d.ts` that imports a `./runtime/` file that way, and
  JavaScript that does anything else passes as one. Review changes to a
  generated client's folder as you would any code.
- `require()` of a package an adapter maps is unverifiable, rather than reaching
  the capabilities the adapter lists; use `import` to have its calls checked.
- Checked by paths rather than a tsconfig.json, every file is read as an ES
  module, as a bundler would load it. So in a project compiled to CommonJS, an
  `import "./theme.css"`, which runs `./theme.css.js` when `./theme.css` doesn't
  exist, isn't reported; check it with `--project tsconfig.json`. (PermLang
  can't tell from the files alone: many bundled projects have no
  `"type": "module"` either.) A `.cts` file, and `require()`, are held to
  CommonJS's rules either way ([loading modules](#loading-modules)).
- A file loaded with `require()` or a traced `import()` reaches every export of
  that file, used or not.
- Interfaces are matched structurally, so a class or object literal that merely
  fits an interface counts as an implementation of it, even if it's never used
  as one. Matching compares every interface a call goes through with every
  class and object literal that has a member of that name, once per interface
  and member, and each such call is linked to every match. That's quick for
  real code, but grows with the product of the two: a thousand interfaces of
  one shape, a thousand classes that fit all of them, and a call through each
  interface take about ten seconds to check.
- A file that TypeScript itself can't parse (code nested thousands of levels
  deep) is unverifiable when it's among the files the check starts from (under
  the paths given, or in the project's file list). One reached only through
  imports still stops the check, with an internal error (exit code 2).
- Lock keys for same-named functions in one file (`#2`, `#3`) follow source
  order, so adding one can renumber the others and show spurious lock changes.
- The Action knows whether the lock file existed before only on pull requests
  and merge-queue entries, from their base commit. On a push, a deleted lock
  file isn't detected.
- A pull request that points the Action at a new lock file is held to the
  base commit's only as far as PermLang can read the base's workflows (see
  [a lock file the change stops using](#a-lock-file-the-change-stops-using)).
  It can't read a step whose `working-directory` or `args` come from an
  expression, such as a matrix, or PermLang run from a reusable workflow in
  another repository; and it takes `working-directory` to be from the
  repository root, as it is unless `actions/checkout` was given a `path:`. So a
  matrix entry changed to a folder with no lock file at the base, for example,
  isn't caught: the check uses that folder's new lock file, and the comment
  lists all its access as new and says the base has no lock file.
- A pull request's own workflow decides whether PermLang runs at all: see
  [protect the workflow itself](#github-action).
- New dependencies are described with the pull request's own adapters. An
  adapter the pull request adds or changes is itself a settings change, which
  fails the check and is listed in the comment.
- Of what package.json can change about installed code, the diff lists new
  dependencies, ones from another source, and overrides (`overrides`,
  `resolutions`, `pnpm.overrides`). It doesn't read `pnpm.packageExtensions`
  (which adds dependencies to a package), patches applied at install
  (`pnpm.patchedDependencies`, patch-package's `patches/` folder), or settings
  outside package.json (`.npmrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`). A
  dependency or override doesn't fail the check by itself either: calls into a
  package with no adapter do (see [code PermLang can't check](#what-the-lock-records)).
- Of tsconfig.json's compiler options, only those listed under
  [what the lock records](#what-the-lock-records) are recorded. The others
  check types more or less strictly, or control emit, output paths, builds, and
  editors; none of them changes which files are read, what an import or a name
  resolves to, or what a default import or JSX element is. (Type-checking
  options can still narrow or widen a type, such as `strictNullChecks` adding
  `undefined`, but not which declaration a call resolves to.)
- JSX isn't modeled beyond the components it names: the function every element
  calls (`jsxImportSource`'s `jsx-runtime`, or `jsxFactory`), and that module's
  top-level code, aren't charged to the code with the JSX. The lock records
  those options, so a pull request that changes them shows, but a per-file
  `/** @jsxImportSource ... */` or `/** @jsx ... */` comment doesn't.
- If the Action can't look up the account its token belongs to, it assumes
  `github-actions[bot]`; with another kind of token, it then adds a new comment
  on each push instead of updating one.
- Databases run code of their own that SQL text doesn't show: triggers, views,
  rules, and row-level security can read or write other tables.
- Table names in SQL are reported as written. Postgres folds unquoted names to
  lower case, so `LEADS` and `"LEADS"` are different tables there but are both
  reported as `LEADS`.
- A mysql2 value cast to a plain type before it reaches `query()`
  (`const id = raw as unknown as number`, then `query(sql, [id])`): its type says
  it's a number, so a `toSqlString()` method it has isn't seen. A cast where the
  value is passed is looked through. Values whose types could hold that method,
  such as an object typed by an interface, need bare `db.read` and `db.write` even
  when they're plain data at runtime; pass a record or an object literal instead,
  or use `execute()`.
- A Drizzle `` sql`...` `` fragment's tables are charged to the code where the
  fragment is written. One kept in a shared constant counts toward its module's
  top-level code (and so toward every importer), not toward each query that uses it.
- Drizzle schema SQL read back by a computed key or by listing a schema object's
  members (`Object.values(check(...))`) isn't seen as SQL; read by name, or
  destructured, it is.
- Prisma relations are read from the payload types that Prisma 5 and later
  generate. With an older client, any `include`, `select`, or nested argument that
  could name a relation needs bare `db.read` (and `db.write` in `data`), as does
  any fluent API step.
- A Prisma query extension runs on every operation it intercepts, but calls through
  the extended client aren't linked to it: `xprisma.lead.findMany()` reaches only
  `db.read(lead)`. What the extension's callback runs is charged to the callback,
  which the code that calls `$extends` reaches (often a module's top-level code), so
  it's in the lock. A callback written as a separate function whose parameter has a
  type of the project's own, rather than the one `$extends` gives it, isn't
  recognized: its `query` is just a function to PermLang.

## Configuration

`permlang.config.json`, in the folder the command runs in (or the file
`--config` names). Every setting is optional.

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
| `PERM005` | error | The code and `permlang.lock.json` differ: the code reaches something the lock doesn't record, or the lock records something the code no longer reaches; a `@perm-unsafe` override is new, gone, or has another reason; the check ran on other files or with other settings than the lock records; the lock is missing (with `--require-lock`, or `--base` when the base commit has it); the change stops checking with the base commit's lock file (with `--base`); or an older PermLang wrote it. See [the lock file](#the-lock-file-and-the-permission-diff). |
| `PERM006` | warning, by default | A call into a package with no adapter, installed or a folder of the project's with its own `package.json`: what it touches isn't checked. See [packages without an adapter](#packages-without-an-adapter). |
| `PERM007` | warning, by default | An import whose types can't be found, so nothing called from it is checked, including an import of an asset-looking file where it compiles to `require()` (see [loading modules](#loading-modules)). Also the global `process` when Node's types are missing (reported as `node:process`). |
| `PERM008` | warning, by default | A tool an AI model can call reaches something dangerous, or tools are given in a way that can't be listed. See [tools given to AI models](#tools-given-to-ai-models). |
| `PERM009` | error | A function gets hold of data a flow rule protects and can send it somewhere the rule doesn't allow: another host, an app capability such as `email.send`, a command, code that can't be verified, or a package PermLang can't see into. See [data-flow rules](#data-flow-rules). |
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
`C:..\x`. Drive letters match in any case. A network path is covered only when
it's inside both as Windows reads it, where `..` can't climb out of the share
(`\\server\share\..\x` is `\\server\share\x`), and as other systems read it
(`//server/share/../x` is `/server/x`): `fs.write(//server/x)` doesn't cover
`\\server\share\..\x\f`.

## Data-flow rules

`@perm` says what a function may touch. A flow rule says where protected data
may *go*: "the Stripe key may only be sent to Stripe".

```json
{
  "flows": [
    { "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] },
    { "from": "db.read(customers)", "to": ["net(api.hubspot.com)", "email.send"] }
  ]
}
```

`from` is data a function reads: `env`, `fs.read`, `db.read`, or `net` (what a
host sends back), with or without a scope. `to` lists where it may go: network
hosts, and app capabilities from [adapters](#adapter-manifests), such as
`email.send`. Anything else, such as `"to": ["fs.write(./public)"]` or
`"from": "exec"`, is a configuration error, and so is a misspelled setting in a
rule, or an app capability no adapter defines (`"email.sent"`): none of them
could ever match. A host is written as calls report it, without a scheme, port,
path, or user: `net(api.stripe.com)`, not `net(https://api.stripe.com)`,
`net(api.stripe.com:443)`, or `net(api.stripe.com/v1)`, which are configuration
errors too (an IPv6 address goes in brackets, `net([::1])`).

A function that gets hold of the `from` data, and can send it somewhere `to`
doesn't allow, is a `PERM009` error. "Somewhere" is:

- a host `to` doesn't list, or a host that can't be determined (`fetch(url)`);
- an app capability `to` doesn't list: an adapter's action, such as sending an
  email with nodemailer (`email.send`), takes the data wherever that action goes;
- a command (`exec`), or code that can't be verified (`eval`, say): either one
  could send it anywhere, so no rule can allow it. That includes code in a
  function marked `@perm-unsafe`: the tag accepts it for annotations, not for
  where data goes;
- a call into a package with no adapter, or into an import whose types can't be
  found: PermLang can't see what it does with what it's given, so it could send
  it anywhere too. This holds whatever `"unmapped"` is set to. To fix it, add an
  [adapter](#adapter-manifests) for the package (one that declares it pure with
  `"default": []`, if it sends nothing), or install its types.

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
- by writing it into an object the caller passed in: `authorize(headers)`
  setting `headers.authorization`, `load(store)` calling `store.set(...)` or
  `bus.emit(...)`, or a callback writing into a list's elements. Any use of
  such a parameter counts except reading it: its fields' values
  (`order.total`, `counts.tries++`), the standard library's methods that change
  nothing (`items.join(",")`, `lines.map((l) => l.sku)`), tests (`if (order)`,
  `!order`, `order === other`, `typeof order`, `ready && order` as a condition),
  and assigning to the parameter itself. Passing it on, storing it
  (`kept = order ?? fallback`), calling it or any other method, or a callback
  nested more than five deep could write to it;
- as the object a constructor builds (`new StripeClient()`), or what a module
  exports.

A function that calls one that returns nothing (`void`, or `Promise<void>`),
takes no callback, and only reads what it's given (or takes only strings,
numbers, and other primitives) isn't flagged for what it sends elsewhere: the
data can't come back to it. So `checkout()` calling
`chargeCustomer(order): Promise<void>` and then an analytics service passes, as
long as `chargeCustomer` only reads `order`.

A `from` without a scope covers a whole category: `"env"` protects every
environment variable. Reading the whole environment (`JSON.stringify(process.env)`)
counts as reading every variable.

**This doesn't follow the value itself.** It works from which functions can get
hold of the data and what they can reach, so:

- data stored somewhere and read by other code isn't followed: a key read into a
  module-level constant, or into an object's field by one method and sent by
  another;
- a function that returns a value is assumed to hand the data back even when its
  result can't contain it, so a caller that also sends elsewhere is flagged. So
  is one that passes on, or calls a method of, an object it's given, even when
  it writes nothing into it;
- data written into an object the function reaches some other way (a field of
  `this`, a variable outside the function) isn't followed: that's data stored
  somewhere, as above;
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
reach, through everything it calls. Only the frameworks below are recognized: a
tool registered with any other package isn't found at all.

| Framework | Recognized |
| --- | --- |
| Vercel AI SDK (`ai`, `@ai-sdk/*`) | `tool({ execute })`, `dynamicTool(...)`; plain objects in a `tools` option, such as `generateText({ tools: { shell: { execute } } })` or `new ToolLoopAgent({ tools })` (see [tools given in a collection](#tools-given-in-a-collection)); provider tools such as `anthropic.tools.bash_20250124({ execute })` |
| OpenAI SDK (`openai`) | the functions `chat.completions.runTools` runs: `{ type: "function", function: { function } }` in its `tools`, `zodFunction({ function })`, `zodResponsesFunction({ function })`, `standardFunction(...)`, `new ParsingToolFunction({ function })`; and handlers in a `toolHandlers` record |
| FastMCP (`fastmcp`) | `server.addTool({ execute })` and `server.addTools([...])` |
| Genkit (`genkit`, `@genkit-ai/*`) | `ai.defineTool(config, fn)`, `ai.dynamicTool(config, fn)`, `tool(config, fn)`, `dynamicTool(config, fn)` |
| MCP (`@modelcontextprotocol/sdk`, and version 2's `@modelcontextprotocol/server`) | `server.tool(name, ..., handler)`, `server.registerTool(name, config, handler)`, and the handler that serves every tool (named `*`): `setRequestHandler(CallToolRequestSchema, handler)`, or `setRequestHandler("tools/call", handler)` in version 2 |
| OpenAI Agents (`@openai/agents`, `@openai/agents-*`) | `tool({ name, execute })`, and the built-in tools that run here: `shellTool({ shell })`, `computerTool({ computer })`, `applyPatchTool({ editor })` |
| LangChain (`@langchain/*`, `langchain`) | `tool(func, ...)`, `new DynamicStructuredTool({ func })`, other `new ...Tool(...)` classes, prebuilt tools that extend `Tool` (such as `new Calculator()`), and your own subclasses of `StructuredTool` or `Tool`, including class expressions (what any of their methods reaches: `_call`, and `invoke` or anything else a subclass overrides) |
| LlamaIndex (`llamaindex`, `@llamaindex/*`) | `FunctionTool.from(fn, ...)` and `tool(fn, ...)` |
| Anthropic (`@anthropic-ai/*`), Mastra (`@mastra/*`) | their `tool`/`createTool`/`betaTool`-style helpers with an `execute`, `run`, or `func` handler, and plain objects with one in a `tools` list (the Anthropic SDK's `toolRunner({ tools: [{ name, run }] })`) |

A package counts by its family, because one package often re-exports another's
(`@openai/agents` re-exports `tool` from `@openai/agents-core`). The handler is
the last function argument when there is one (MCP's callback, LangChain's
`func`), else the definition's function-valued `execute`, `run`, `func`, or
`function` (written as `execute`, `"execute"`, or `[KEY]` with a constant `KEY`,
or in a definition spread in from a constant), else a built-in tool's `shell`,
`computer`, or `editor` object, whose methods are what runs. A schema property
that happens to be called `run` isn't a handler.

### Tools given in a collection

Tools are often handed to a framework together: a `tools` option
(`generateText({ tools })`, `new Agent({ tools: [...] })`,
`runTools({ tools: [...] })`), the OpenAI SDK's `toolHandlers` record, or
FastMCP's `addTools([...])`. PermLang reads the collection where it's written: in
the call, in options spread into it from a constant (`{ ...options, prompt }`), in
a constant it names, with what's spread in (`{ ...shared }`, `[...list]`) and
what's added to that constant later (`tools.shell = {...}`,
`tools["shell"] = ...`, `list.push(...)`). Each entry is:

- a plain object with a handler: a tool, named by its key or its `name`;
- a tool a framework function made (`tool({...})`, `new ShellTool()`, a function
  of yours whose every `return` gives one), a value whose type the framework
  declares (a parameter typed as its `Tool`), or a tool's name: these are
  registered where they're made, and aren't counted twice;
- a function: the tool's handler;
- a schema with no handler: the app answers the model itself, so it's skipped.

Anything else could be any tool, and so could a collection that can't be read: a
parameter, a variable that can be reassigned, a function's result (such as
`Object.fromEntries(...)`), options passed in from elsewhere, a plain object a
helper of yours builds, or a constant changed in ways that can't be read
(`Object.assign(tools, more)`, `tools.shell.execute = run`). Each is listed as a tool that
reaches `unverifiable`, named by its key, or `*` for a whole collection, with a
`PERM008` warning saying it can't be listed. That only happens where the
collection's type allows a tool the framework runs: the schema lists of the
OpenAI or Anthropic SDK's message calls (`create({ tools })`) can't hold one.

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

The lock records what each function reaches, not which tools exist. A new tool
whose code reaches something new fails the check like any new access. But a new
tool that reaches only what its file's code already reached (a second
command-running tool next to the first, say) doesn't change the lock: with the
default `"warn"`, it gets a `PERM008` warning, and the permission diff doesn't
show it. Use `"tools": "error"` to fail on it.

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
- Unverifiable code in a function marked `@perm-unsafe` still counts. The tag
  accepts that code for the function's annotations and its callers', but a
  model's input still reaches it: a tool that hands a template to a reviewed
  `eval` reaches `unverifiable`.
- A tool without a handler here counts as unverifiable too, unless its type says
  it runs at the model provider: the AI SDK hands its calls back to your app, a
  provider tool like `bash_20250124()` runs them in whatever sandbox the call is
  given, and a library's prebuilt tool runs its own code.
- A tool whose framework types it as running at the provider reaches nothing
  here: OpenAI Agents' `HostedTool` (`webSearchTool()`, `fileSearchTool(...)`, a
  hosted `shellTool({ environment })`) and the AI SDK's `ProviderExecutedTool`
  (Anthropic's code execution). A type of your own with such a name doesn't count.
  Callbacks given to such a tool still run here: `hostedMcpTool({ onApproval })`
  reaches what `onApproval` does, and options PermLang can't see (a parameter, a
  spread) count as unverifiable when their type allows a callback.

Not recognized yet:

- Tool frameworks other than those in the table above.
- Tools registered through a wrapper of your own
  (`function addTool(name, fn) { server.registerTool(name, {}, fn) }`) are found
  inside the wrapper, where the handler is a parameter, so the tool counts as
  unverifiable. The handlers its callers pass aren't followed.
- Plain-object tools that reach a framework through a function of yours: a
  helper that takes the `tools` record or list as a parameter and passes it on is
  reported as one tool PermLang can't follow (see above), not as the tools its
  callers give it. A constant record changed by a function it's passed to isn't
  noticed.
- An entry typed as the framework's own tool type is taken to be registered where
  it's made. A plain object you build and annotate with that type
  (`const shell: Tool = { execute }`), then pass to the framework through a
  parameter, isn't followed.
- Tool lists that are only schemas, such as the `tools: [...]` of the Anthropic or
  OpenAI SDK's message calls (`messages.create`, `chat.completions.create`,
  `responses.create`). Your own code answers the model's calls there, wherever it
  handles them, and PermLang can't link that code to the tool. (The OpenAI SDK's
  `runTools` is different: it runs the functions it's given, and those are
  recognized.)

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
| `ci.unverifiable(sha256:…)`, `npm.unverifiable(sha256:…)` | A file, or part of one, PermLang can't read: YAML that doesn't parse, a workflow without both `on:` and `jobs:` (GitHub wouldn't run it as written, and stray invisible characters can make PermLang and GitHub read it differently), an alias with no anchor before it, an image named by an expression, a link that leads nowhere, line breaks that YAML parsers disagree on ([below](#how-workflows-are-read)). It's recorded rather than skipped, so it can't hide anything, with the file's SHA-256, so that any edit to the file changes the lock and shows in review. Line endings and a byte-order mark don't count, since Git can change them on checkout. |

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
- **Line breaks YAML parsers disagree on.** The Actions runner parses YAML with a
  library that, like YAML 1.1, also ends a line at the invisible characters U+0085,
  U+2028 and U+2029, so after `# note<U+2028>` it can read a key that other parsers
  take as part of the comment. A workflow or Action containing any of them is
  unverifiable. The rest of it is still read, and since the entry carries the file's
  hash, any edit to the file changes the lock. In an expression, U+0085 separates
  words, as it does to the runner.

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

Upgrading from 0.3 or earlier changes these entries too: see
[upgrading from 0.3](#upgrading-from-03-or-earlier).

## Adapter manifests

A manifest maps a package's functions to capabilities:

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

- `package` is the package's name, or a list of names that share the manifest.
- `defines` lists the app-level capabilities the manifest introduces, such as
  `payments.refund`. A `@perm`, a spec, or a flow rule can name only the
  built-in capabilities and ones an adapter defines, so a misspelling is an
  error.
- `functions` keys are `Container.member`, where the container is the class,
  interface, or type alias that declares the function: `Container()` for a call
  signature, `Container.constructor` for a constructor, and a bare `name` for a
  top-level function. Keys must match how the package's types declare the
  function: `process.kill` is declared on the `Process` interface, so its key is
  `Process.kill`, not `kill`. An empty list maps a function to nothing.
- `default` applies to every other method in the package (not constructors).

A scope can come from the call's arguments (counted from 0):

- `{arg:N}` is argument N, when it's a literal string.
- `{host:N}` reads a URL, a template with a literal host, `new URL(...)`, or an
  options object whose `url`, `hostname`, and `host` all name the same host (for
  the `net` and `tls` modules, the options' `host`, as Node reads it). A spread,
  an accessor, a computed key, or a `socketPath`, `lookup`, or `createConnection`
  option makes it unknown.
- `{host:N+}` reads argument N the way Node's `http.request(input, options)`
  does: `hostname` before `host`, no `url` option, and an options argument after
  a URL can replace its host with `hostname`.
- `{host:N?}` counts only when argument N can set a host (Stripe's
  `new Stripe(key, { host })`); a config that doesn't name one adds nothing.

A placeholder that can't be read gives the bare capability, so the call needs,
say, `net`. Add your own adapters in `permlang.config.json`; they take
precedence over the built-in ones:

```json
{ "adapters": ["./permlang/adapters/acme-sms.json"] }
```

For database clients, PermLang's own detection applies first, and adapters add
to it.

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

The same policy applies to imports whose types can't be found (PERM007). Whatever
the policy, the lock records each package with no adapter and each import with
no types, so a new one fails the check until `permlang lock` records it, and the
permission diff lists it under **New code PermLang can't check** (see
[what the lock records](#what-the-lock-records)).

A package that touches nothing PermLang tracks is declared pure with an adapter
whose `default` is `[]`. [`adapters/pure.json`](../adapters/pure.json) does this for
Node's pure built-ins and common libraries (zod, date-fns, React, ...).

A folder of the project's with its own `package.json` is a package too: a client
generated into the project, or a workspace package that an import reaches
through a link. PermLang reads its `.d.ts` files but not its JavaScript, so a
call into it is listed and warned about like a call into an installed package,
named by its `package.json`'s `name` (or by its folder, such as `./src/gen`,
when it has none), wherever it's imported from. Since that `name` could claim
to be any package, only your own adapters (in `"adapters"`) cover such a folder:
a folder named `lodash` isn't pure, and one named `@prisma/client` isn't read as
Prisma. An adapter of yours covers every folder that takes its package's name,
so review a new `package.json` in the repository as you would code. The
exception is a client prisma-client-js generates there, which the Prisma
detector covers (see [known limits](#known-limits)).

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
(tar 7's typings give every command one shape, so listing counts as a write too),
and so does calling one of the functions a tar 7 command dispatches to directly
(`tar.x.syncFile(...)`, `asyncFile`, `syncNoFile`, `asyncNoFile`).
Some otherwise pure libraries have a few functions that aren't: cheerio's
`fromURL`, rxjs's `ajax`, `fromFetch`, and `webSocket`, and react-dom's resource
hints (`preload`, `preconnect`, ...) reach the network; react-dom's `preinit` and
`preinitModule` also run the script they load, and lodash's `template` compiles
its text into code, so those three are unverifiable.

## Strictness levels

Set `"strictness"` in `permlang.config.json`, or pass `--strictness`:

| Level | What fails |
| --- | --- |
| `sketch` | Only what you ask for explicitly: any difference between the code and the lock file (`PERM005`), such as access it doesn't record, flow rules (`PERM009`), and `"unmapped": "error"` or `"tools": "error"`. Rules about `@perm` annotations are reported as warnings, and every function's permissions are inferred. Start here on an existing codebase. |
| `development` (default) | All of the above, plus annotated functions that exceed their `@perm`, invalid annotations, unverifiable code, and [exported functions, entry points](#exported-functions-and-entry-points), or top-level code without `@perm`. |
| `production` | All of the above, plus any function (private helpers too) that reaches something without being covered by function- or module-level `@perm`. |

## The lock file and the permission diff

`permlang lock` writes `permlang.lock.json`: what every function can reach, what
every workflow, Action, and `package.json` script grants, which files the check
ran on and with which settings, and the code PermLang can't check. Commit it.
From then on:

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
  - The code calls a package with no adapter, or imports something with no
    types, that the lock doesn't record, or no longer calls or imports one it
    records (see [what the lock records](#what-the-lock-records)).
  - The check ran on other files, or with other settings, than the lock records
    (see below).

  To approve any of these, run `permlang lock` and commit the change, so
  reviewers see it.
- **`permlang diff <base-ref> [paths...]` shows what changed since `base-ref`**, one row per
  new capability, with where it happens and which functions can now reach it:

  | New access | Where it happens | Now reachable from |
  | --- | --- | --- |
  | `+ net(api.data-broker.io)` | `enrich`<br>fetch("https://api.data-broker.io/v2/enrich", ...) | `enrich` (new), `handleLead` |

  The diff compares `base-ref`'s lock with what the code reaches now, not only
  with the lock file on disk. With `--head <ref>`, it compares two committed lock
  files. Above the table, it says whatever makes it incomplete or the check fail:
  - **Not approved yet**, when the code and the lock file don't match. Access the
    lock records but the code doesn't reach is listed under its own heading.
  - When the change deletes the lock file, or an older PermLang wrote it.
  - When the change stops checking with the lock file the base commit's
    workflows check with (see
    [a lock file the change stops using](#a-lock-file-the-change-stops-using)).
  - When the code couldn't be analyzed (an invalid setting, say). The diff then
    shows only what the lock files record, says so, and never says "No permission
    changes".
  - When the base commit has no lock file, so everything is listed as new, or an
    older PermLang wrote it, so the settings are listed as new.

  Changes to what's checked, or how strictly, are listed under **Check settings
  changed**, such as `unmapped: now trust, was warn`, or an `exclude` added to
  tsconfig.json. New and changed `@perm-unsafe` reasons are listed with the old
  reason.

  **New code PermLang can't check** lists each import whose types can't be found
  (PERM007, such as a `.js` or `.cjs` file next to the code) and each package the
  code calls with no adapter (PERM006, including one vendored into a
  `node_modules` folder inside the project) that the base's lock doesn't record,
  with where it's first imported or called. What that code does isn't in the
  diff, so it needs a reviewer's eye: it fails the check until `permlang lock`
  records it, whatever the `"unmapped"` policy.

  The diff also lists **new dependencies**: packages the change adds to
  `./package.json`, in `dependencies`, `devDependencies`, `optionalDependencies`,
  or `peerDependencies`. For each one, it says what PermLang sees (checked by an
  adapter, declared pure, detected directly, or **not checked** because it has no
  adapter) and lists its `preinstall`, `install`, and `postinstall` scripts when
  it's installed. It also lists a package already there that the change now
  installs from somewhere other than the registry: an alias
  (`"lodash": "npm:evil-lodash@1.0.0"`), a URL, git, or a local folder or tarball.
  Its name, and so its adapter, stay the same while its code changes. And it lists
  each override that's new or says something else now, since an override replaces
  a package's code wherever it is in the dependency tree, without touching its
  dependency entry: npm's `overrides` (nested ones too, shown as
  `react > lodash.merge`), Yarn's (and pnpm's) `resolutions`, and `pnpm.overrides`.
  One that installs from another source says so, like a dependency that does; one
  that pins a registry version says **Overridden**. When the code reaches the same
  access, the comment says "No permission changes. The dependencies changed,
  though: review them below." These are there for review: they don't fail the
  check by themselves, but once the code calls into a package with no adapter,
  it's recorded as code PermLang can't check (above), which does.

`--format markdown` produces the pull-request comment. Text from the code is
escaped so it can't change the comment: it can't break out of code formatting or
a table, hide rows in an HTML comment, mention people (`@name`), or link issues,
commits, URLs, or emoji (an invisible zero-width space breaks those). Control
characters and bidirectional overrides show as escapes (`\u202e`), as in the
text output.

The comment stays under GitHub's length limit. Each value from the code (a
capability, a name, a path, a reason) is cut to 500 characters, and a cell names
at most 20 functions, AI tools, or capabilities, then says how many more. When
the comment would still be too long, it leaves rows out: the new-access table
comes first, right after the warnings at the top, and each later section gets
what room is left. A row too long for the room left is skipped, and shorter rows
after it still go in, so one long row can't push the others out. A note says how
many lines are left out. `--summary <file>` also writes the diff, cut only to
GitHub's 1 MiB limit on a job summary, which is where the Action puts it.

If the diff can't be computed at all (the base commit can't be read, or the
arguments are wrong, say), `--format markdown` still prints a comment that says
so, and the command exits 2. With no lock file in the working tree or at the
base commit, there's nothing to compare: the command exits 2, and
`--format markdown` prints a short notice saying so. The exception is a change
that stops checking with the lock file the base's workflows check with (such as
`args: src --no-lock` where the base had `--lock locks/app.json`): then the diff
lists all access as new, under a warning that says so, since the check fails.

`--format json` (or `--json`) is for tools, and includes `unrecorded` (where the
code and the lock file differ, or `null`), `unsafeChanged`, `analysisError` (or
`null`), `lockDeleted`, `lockMoved` (the base's lock files the change stops
checking with), `baseLockMissing`, `dependencies` (each with its `section`,
and `change`: `added`, `source`, or `override`, which also names its `target`
package), and `aiTools` (for each capability, the AI tools that can reach it).
Changes in the code PermLang can't check are among `functions`, under the key
`permlang.config.json#<unchecked>`.

The text output of `check`, `lock`, `diff`, and `spec`, its GitHub annotations,
and its error messages escape line breaks, control characters, and bidirectional
overrides in anything from the code or a file (`\n`, `\u001b`, `\u202e`), so a
string in the code can't print a line of its own, which GitHub Actions would
obey as a workflow command, drive the terminal, or read differently than it is.
In GitHub Actions (where `GITHUB_ACTIONS` is `true`, or with
`--github-annotations`), every command also tells the runner to ignore workflow
commands until a token only that run knows, on standard error, so standard
output stays as it is. A path such as `::stop-commands::x/app.ts`, from a folder
named that way, can't start one either. The check's own annotations come after
the token.

The check compares against `./permlang.lock.json` whenever it exists. When
checking other files from the same folder (like the fixtures here), pass
`--no-lock`.

### What the lock records

```json
{
  "permlang": 2,
  "functions": {
    ".github/workflows/ci.yml#<ci.yml>": [
      "ci.permission(contents: read)",
      "ci.trigger(pull_request)"
    ],
    "permlang.config.json#<permlang.config.json>": [
      "permlang.files(src)",
      "permlang.strictness(development)",
      "permlang.tools(warn)",
      "permlang.unmapped(warn)"
    ],
    "permlang.config.json#<unchecked>": [
      "unchecked.package(posthog-node)"
    ],
    "src/leads.ts#handleLead": [
      "email.send",
      "net(api.hubspot.com)"
    ],
    "src/render.ts#compile": [
      "unverifiable"
    ]
  },
  "unsafe": {
    "src/render.ts#compile": "template compiler; trusted input"
  }
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
| `permlang.imported(file)` | Each file the check read only because a checked file imports it, directly or through other files (see [which files are checked](#which-files-are-checked)). |
| `permlang.strictness(level)`, `permlang.unmapped(policy)`, `permlang.tools(policy)` | The settings in effect: a command-line option (or the Action's `strictness` input), else `permlang.config.json`, else the default. |
| `permlang.flow(from -> to)` | Each [flow rule](#data-flow-rules). |
| `permlang.adapter(path sha256:...)` | Each adapter manifest, from the config file or `--adapter`, with the first 16 hex digits of the SHA-256 of its content. The content is hashed as parsed JSON, so line endings and formatting don't change it. |

When the files come from a TypeScript project, its config is an entry too
(`tsconfig.json#<tsconfig.json>`, with capabilities such as
`tsconfig.include(src)`): its `include`, `exclude`, and `files` after following
`extends` (TypeScript's defaults when they aren't set: everything included, the
output folders excluded), and the compiler options that decide which files are read, what an
import or a global resolves to, and what a default import or a JSX element is:

- Always, with the value TypeScript uses, whether set or worked out from the
  others (`module` decides `moduleResolution`, and both decide whether a default
  import of a CommonJS module is the module): `target`, `module`,
  `moduleResolution`, `moduleDetection`, `esModuleInterop`,
  `allowSyntheticDefaultImports`, `resolvePackageJsonExports`,
  `resolvePackageJsonImports`, and `useDefineForClassFields`. A change that
  turns default imports off reads
  `tsconfig.json now has allowSyntheticDefaultImports false, but permlang.lock.json records allowSyntheticDefaultImports true`.
- When set: `baseUrl`, `paths`, `rootDirs`, `typeRoots`, `types`, `lib`,
  `customConditions`, `moduleSuffixes`, `libReplacement`, `jsx`, `jsxFactory`,
  `jsxFragmentFactory`, `jsxImportSource`, and `reactNamespace`.
- When on: `noLib`, `allowJs` (or `checkJs`, which turns it on),
  `preserveSymlinks`, `allowArbitraryExtensions`, and `importHelpers`.

`noResolve` isn't recorded, because the check doesn't use it: it follows
imports whether or not TypeScript is told to, since the imported code still runs.

A tsconfig.json that can't be parsed, extends a file that isn't there, lists a
file in `"files"` that isn't there, or selects no files at all is an error (exit
code 2), and so are paths that hold no TypeScript files: a check of nothing
would pass.

The code PermLang can't check is an entry of its own, next to the settings,
keyed `permlang.config.json#<unchecked>`:

| Capability | What it records |
| --- | --- |
| `unchecked.import(src/telemetry.cjs)`, `unchecked.import(left-pad)` | Each import whose types can't be found (PERM007): a relative one by the path of the file it names, from the lock's folder (so `./x.cjs` in two folders is two entries), anything else as written. |
| `unchecked.package(leftpad2)` | Each package the code calls that has no adapter (PERM006). |

A new one fails the check, at the line that imports or calls it, until `permlang
lock` records it; so does one the lock records that the code no longer has.

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
(PERM005). With `--base <ref>`, which the GitHub Action passes on pull requests,
it's an error when `<ref>` has the lock file this check reads. A `--lock <file>`
that doesn't exist is a usage error (exit code 2), so a mistyped path can't turn
the comparison off. `--no-lock` with `--require-lock`, or with a `--base` that
has the lock, is a usage error too. Without any of these, a check with no lock
file checks only annotations.

#### A lock file the change stops using

A change could leave the base commit's lock file behind: point the Action at a
new lock file (`args: src --lock permlang.lock.v2.json`) or another folder
(`working-directory`), and approve its own access in a lock file nobody has
reviewed. So `check --base <ref>` also reads the workflows at `<ref>` and in the
working tree, and finds the steps that run the PermLang Action
(`PermLang/permlang@...`, or a local Action named PermLang, such as `uses: ./`
in PermLang's own repository) and the lock file each one reads, from its
`working-directory` and the `--lock` in its `args`. The check fails (PERM005)
when it reads a lock file none of `<ref>`'s steps read, and a lock file one of
them read, which `<ref>` has, is no longer read by any step:

```
permlang.lock.v2.json:1:1 error PERM005: This change stops checking with permlang.lock.json, which the base commit's workflow checks with, and this check reads permlang.lock.v2.json instead. A lock file the base doesn't check with can approve whatever the change adds.
```

When no step at `<ref>` names its lock file plainly (there's no workflow, or its
inputs come from an expression such as `${{ matrix.dir }}`), `<ref>`'s lock file
is taken to be `permlang.lock.json` in the folder the check runs in.

In the working tree, a step only counts as still checking with a lock file when
it's sure to run for this pull request, and to fail its job when it fails.
GitHub counts a skipped job as passed, so a step that never runs could otherwise
stand in for the real check. A step doesn't count when:

- its workflow doesn't run on `pull_request`, or only for some pull requests
  (`branches`, `branches-ignore`, `paths`, `paths-ignore` or `types` under
  `pull_request`);
- the step, its job, or a job its job `needs` has an `if:` other than
  `always()` or `!cancelled()`. A job with one of those runs even when a job it
  needs fails, so those jobs don't matter;
- the step or its job has `continue-on-error:` (other than `false`).

Adding a package to a monorepo, with a step and a lock file of its own, passes:
the base's lock files are all still checked with. To move a lock file (rename
it, or move the project), do it in two pull requests: the first adds a step that
checks with the new lock file next to the old one, and once that's merged, the
second removes the old step. Each pull request's comment shows what its new lock
file records. A pull request that both drops a package's step and adds another
package fails; split it the same way.

#### Upgrading from 0.3 or earlier

Locks written before 0.4 are format 1, which recorded no settings. `permlang
check` fails on one with a single error:

```
permlang.lock.json:1:1 error PERM005: permlang.lock.json was written by an older PermLang (lock format 1), which recorded less than this version checks.
  -> run `permlang lock` once to update it, and commit the change.
```

Run `permlang lock` once, with the paths and options your check uses, review the
change, and commit it. GitHub Action users on `@v0` get 0.4 automatically, so
their next run fails this way until the updated lock is committed. Nothing in a
pull request can make the check lenient instead: there's no grace period. In the
pull request that updates the lock, the comment lists the settings as new, since
the old lock didn't record them.

Run it with PermLang 0.4. A project that installed PermLang with
`npm install --save-dev permlang` has `"permlang": "^0.3.x"` in its
`package.json`, which never installs 0.4, and 0.3 writes the old format again.
Update it first (`npm install --save-dev permlang@^0.4.0`). 0.3 can't read a
0.4 lock either: it stops with `unsupported lock file version 2`.

The updated lock can record more than the old one. 0.4 reports access that 0.3
missed, and records more: the settings, which files were checked, and the code
PermLang can't check (see [what the lock records](#what-the-lock-records)). For
workflows and `package.json` scripts, it reads configuration it missed before
(aliases, secrets written other ways, local Actions, images, workspace packages),
names secrets in upper case, adds a hash to unverifiable entries, and no longer
records secrets mentioned outside an expression, or `uses:` keys that aren't on
steps or jobs. Review all of it before committing.

`permlang lock` also replaces a lock it can't read at all (one with
merge-conflict markers, say), with a warning to review all of it.

## GitHub Action

```yaml
# .github/workflows/permlang.yml
on: [pull_request]
permissions:
  contents: read
jobs:
  # Installs the dependencies, apart from the check.
  dependencies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
      - run: npm ci --ignore-scripts   # or pnpm / yarn; see below
      - name: Pack the dependencies for the check
        run: find . -name node_modules -type d -prune -print0 | tar --null -cf "$RUNNER_TEMP/dependencies.tar" -T -
      - uses: actions/upload-artifact@v7
        with:
          name: permlang-dependencies
          path: ${{ runner.temp }}/dependencies.tar
          retention-days: 1
  # The check, where nothing from the pull request runs.
  permissions:
    needs: dependencies
    if: always()         # so it fails, not skips, when installing fails
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: PermLang/permlang@v0
        with:
          dependencies: permlang-dependencies
          args: src            # or --project tsconfig.json
```

**Dependencies, in a job of their own.** PermLang reads code through the
TypeScript compiler, so it needs your dependencies' types, `@types/node` above
all. Without them, file, process, and environment access are invisible, and the
check reports `PERM007` warnings instead of what the code does.

Installing them runs code the pull request controls, though, even with install
scripts off. pnpm loads `.pnpmfile.cjs`; Yarn 2 and later run the file
`.yarnrc.yml`'s `yarnPath` names, and its plugins; npm runs the program a
project `.npmrc` names as `git` when the lockfile has a git dependency. Code
that runs in the check's job before the check can change what it runs or
reports. So the dependencies install in another job, which packs every
`node_modules` folder into an archive and uploads it, and the check's job runs
nothing from the pull request. The Action's `dependencies` input names that
archive's artifact, and the Action brings it in before the check:

- Only `node_modules` folders come in, and the folders `generated` names.
- A link in them must be relative, stay in the repository, and keep out of
  `.git`. pnpm's links between `node_modules` folders, and a workspace's links
  to its own packages, are fine.
- Each folder must be new to the checkout, in a folder of the checkout's own,
  with no link on the way, so the checkout's files, which the check reads as
  the pull request's code, never change.
- Anything else fails the step, and nothing comes in. So does a Windows runner,
  whose `tar` unpacks a link as a copy of what it points to.

**Keep `if: always()` on the check's job.** When a job fails, GitHub skips the
jobs that need it, and counts a skipped job as passed, also as a required check.
A pull request could then make the install fail on purpose, and skip its own
check. With `if: always()`, the check's job runs anyway, and fails: there are no
dependencies to download. 0.4.2's `init` left it out; add it beside `needs:`, or
make the dependencies job a required check too.

**Don't run the pull request's code in the check's job.** That includes
installing, building, testing, and code generation: any step before the Action
in its job. A workflow written by an earlier `init`, or by hand, that installs
in the same job lets a pull request change the check's result. Split it as
above, or run `permlang init --workflow` again after deleting it.

**Generated code.** Run generators, such as `prisma generate`, in the
dependencies job, after installing. Code generated into `node_modules` (Prisma's
default before its `prisma-client` generator) comes along. For code generated
elsewhere, such as `src/generated`, add its folder to the archive, and name it
in the check's `generated` input:

```yaml
      - name: Pack the dependencies for the check
        run: |
          { find . -name node_modules -type d -prune; echo src/generated; } |
            tar -cf "$RUNNER_TEMP/dependencies.tar" -T -
# ...
      - uses: PermLang/permlang@v0
        with:
          dependencies: permlang-dependencies
          generated: src/generated
```

A generated folder mustn't be committed: the check refuses to replace a folder
the checkout has.

What `init --workflow` writes:

- **Two jobs**, as above: `dependencies`, which installs and packs, and
  `permissions`, which checks. Both check out without keeping the token in the
  repository's git config (`persist-credentials: false`), and only the check
  gets `pull-requests: write`.
- **pnpm and Yarn** come through Corepack, which the workflow installs from npm
  first (`npm install --global corepack@latest`), since Node 25 and later no
  longer include it. Yarn 2 and later (a `.yarnrc.yml`, or a Yarn 2 lockfile)
  install with `--immutable --mode=skip-build`; Yarn 1 with
  `--frozen-lockfile --ignore-scripts`.
- **Triggers**: pull requests, merge queues (`merge_group`), and pushes to the
  repository's default branch (from `origin`'s HEAD, else `main`).
- **In a monorepo package**, run `init` in the package: the workflow goes in
  the repository's `.github/workflows/`, named after the package
  (`permlang-packages-api.yml`), with `working-directory` set to it. When
  another folder's workflow already has that name (`packages/web` and
  `packages_web` both make `permlang-packages-web.yml`), the new one's name
  gets a hash of the folder's path. The package's lock records only what's
  in the package: its own `package.json` scripts, but not the workflows in the
  repository's `.github/workflows/`, so the package's check doesn't fail when a
  workflow changes. To have workflows checked too, run PermLang at the
  repository root as well (`permlang init` there), or have a code owner review
  `.github/workflows/`.
- **Dependencies** install with the package manager whose lockfile is nearest,
  from the project's folder up to the repository root, and in that lockfile's
  folder: at the root of a workspace, or in a project's own subfolder (with
  `working-directory` on the install step). With no lockfile, `npm install`
  runs where the nearest `package.json` is.
- **`args`** has the paths or `--project` init checked, and the `--config`,
  `--adapter`, `--unmapped`, and `--lock` options it was given, so the first
  pull request's check runs with the same settings the lock records. Paths are
  written relative to the folder init runs in, with forward slashes. `init`
  refuses, before writing anything, a path the Action can't pass: one with a
  space (list such files in a `tsconfig.json` and use `--project`), one outside
  the repository, or one with `${{` or a control character in it.
- **Names** that YAML would read as something else (`@acme/api`, `#x`, `[a]`,
  `1e3`) are written in double quotes.

`init` keeps an existing config, workflow, or lock. It writes the workflow
before the lock, so the lock records it and the first pull request passes.

The Action runs `permlang check`, fails the build on errors, and posts the
permission diff as a pull-request comment, updating it on later pushes. Each
problem also appears as an annotation on its line in the pull request's
**Files changed** tab, and in the check's summary. GitHub shows up to 10 error
and 10 warning annotations per step; the full list is in the log and the
comment. This repository runs it on itself (see
`.github/workflows/permlang.yml` and `permlang.lock.json`).

`@v0` follows the latest 0.x release. A minor release (0.3, 0.4, ...) can
detect more and fail builds that passed before (0.4 fails every existing lock
once: see [upgrading from 0.3](#upgrading-from-03-or-earlier)); the
[changelog](../CHANGELOG.md) says when. To upgrade on your own schedule, pin an
exact release instead. The safest pin is the release's commit, since a tag can
be moved (`PermLang/permlang@<commit-sha> # v0.4.0`); Dependabot keeps such pins
up to date. See the [releases](https://github.com/PermLang/PermLang/releases).

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
| `args` | | Arguments for `permlang check`: source paths, or `--project tsconfig.json`, and options such as `--lock` or `--config`. They're split on spaces, so a path can't have one. An option `check` doesn't take is an error. |
| `strictness` | | `sketch`, `development`, or `production`. Overrides `permlang.config.json`. |
| `working-directory` | `.` | Where the code, `permlang.config.json`, and `permlang.lock.json` are. |
| `comment` | `true` | Post the permission diff as a pull-request comment. |
| `sarif` | `false` | Also upload the findings to code scanning. |
| `github-token` | `github.token` | Token for the comment. |
| `dependencies` | | The artifact, uploaded by an earlier job, with a tar archive of the project's `node_modules` folders, which the check reads types from (see [dependencies, in a job of their own](#github-action)). Linux and macOS runners. |
| `generated` | | Folders, from the repository root and split on spaces, that the installing job generated outside `node_modules` and packed too. They mustn't be committed. |

| Output | Meaning |
| --- | --- |
| `exit-code` | The exit code of `permlang check`: `0` no errors, `1` permission errors, `2` anything else (a usage or configuration error, a file that can't be read or written, or an internal error). |

**The inputs and the lock file.** `args` and `strictness` change what's checked,
so the lock file records them, as it does `permlang.config.json`: a pull request
that changes them in its workflow fails the check until `permlang lock` is run
with the same arguments and options, and committed. For a workflow with
`args: src` and `strictness: sketch`, that's `npx permlang lock src --strictness sketch`.

**A deleted or replaced lock file.** On pull requests and merge-queue entries,
the Action makes sure it has the base commit (fetching just that commit into a
shallow clone; a full clone, `fetch-depth: 0`, already has it and stays full),
and runs the check with `--base <the base commit>` (see
[a lock file the change stops using](#a-lock-file-the-change-stops-using)).
PermLang reads `args` itself, as the check does, so it knows which lock file
the check reads:

- When the base has that lock file, the check requires it: deleting the lock
  fails the check, and the comment says the pull request deletes it.
- When the pull request points the check at a lock file the base commit's
  workflows don't check with (by changing `--lock` in `args`, or
  `working-directory`), and stops checking with the base's own, the check
  fails, and the comment says so.
- When the base commit can't be fetched, the lock is required anyway, with a
  warning. A checkout that didn't keep its token (`persist-credentials: false`,
  as in the workflow `init` writes) can't fetch from a private repository, so
  then the Action fetches with its `github-token`, passed to that one `git
  fetch` and kept nowhere.

`--no-lock` in `args` then stops the check with a usage error. So do options
`check` doesn't take, and `-h` or `--help` with anything else, rather than being
ignored.

**The comment.** The Action updates its own comment on each push. It finds the
comment by its first line, a marker that names the `working-directory` when it
isn't the repository root (so runs for several folders each keep their own), and
by the account of the token that posted it: `github-actions[bot]` for the default
token, or a personal token's owner. It never edits a comment from another
account. The comment's text goes to GitHub in a file, and stays under GitHub's
length limit; the job summary gets the diff uncut (up to GitHub's 1 MiB limit
there). If its comment can't be updated, the step fails, since the old comment
would go on looking current. If the diff can't be computed, the comment says so
instead, even when it's `args` that's wrong; and when the check itself stopped
with an error (exit code 2), the comment says so first, whatever the diff
shows. When neither the pull request nor
its base commit has a lock file, there's no diff: the Action posts no comment,
but replaces one it posted earlier (when a later push deleted the pull
request's new lock file, say) with a notice saying so. Other problems (fetching
the base commit, posting a first comment without `pull-requests: write`) are
warnings, and the diff is always in the job summary. A pull request from a fork
gets the diff in the job summary only, since its token is read-only.

**Protect the workflow itself.** On `pull_request`, GitHub runs the workflow as
the pull request has it, so a pull request can remove the PermLang step, change
its inputs, or add `continue-on-error: true`, and its own run then passes. The
change to the workflow shows in the pull request, and PermLang's lock records
the workflow's permissions, triggers, and Actions, but nothing PermLang does
can stop a workflow that doesn't run it. So:

- Make the PermLang job a **required status check** in the branch's protection
  rules or ruleset, so a pull request whose workflow doesn't run it can't merge.
- For stronger protection, run it as a **required workflow**, with a ruleset's
  "Require workflows to pass before merging" rule (where your GitHub plan
  offers it): GitHub then runs the workflow from the repository and branch the
  rule names, not as the pull request has it.
- Have a code owner review changes to `.github/workflows/` (a `CODEOWNERS` entry).

**`pull_request_target`.** Use `pull_request`. Under `pull_request_target`, the
comment step doesn't run (it runs on `pull_request` only), and
`actions/checkout` checks out the base branch unless told otherwise, so the
check runs on the base's code, not the pull request's. Checking out the pull
request's code there instead runs it with a token that can write, which is
what `pull_request_target` warns against.

**Node.** The Action runs PermLang on Node 22, from the runner's tool cache, by
its full path, so the Node your later steps use doesn't change. On a runner
without Node 22 in its tool cache (some self-hosted runners), it installs it
with `actions/setup-node` (with its package-manager cache turned off), which
does put it first on the PATH for later steps.

**PermLang's own build.** The Action builds PermLang from its sources and its
lockfile (`npm ci --ignore-scripts`, then the TypeScript compiler). On a push,
or a scheduled or manual run, it keeps the build in the Actions cache, keyed on
PermLang's sources, so later runs skip that. It never uses the cache for a pull
request or a merge queue entry, though: GitHub looks first in the pull
request's own cache, which any job that runs for it can write to, so the pull
request's code could put a build of its own there. Those runs build PermLang
every time, which takes about half a minute.

## Command line

Install PermLang in the project (`npm install --save-dev permlang`), then run it
with `npx`:

```bash
npx permlang init src --workflow                  # set up: a sketch config, a workflow, and a first lock
npx permlang check src                            # check permissions, and compare with permlang.lock.json
npx permlang check src --json                     # JSON report of declared vs. actual permissions
npx permlang check src --github-annotations       # also print GitHub Actions annotations (the Action does this)
npx permlang check src --sarif out.sarif          # also write the findings as SARIF, for code scanning
npx permlang check src --no-lock                  # check without comparing with the lock file
npx permlang lock src                             # write permlang.lock.json
npx permlang check src --require-lock             # also fail when permlang.lock.json is missing
npx permlang check src --base origin/main         # ...and as the Action does: see "A missing lock file"
npx permlang diff origin/main src                 # permission changes since main
npx permlang diff origin/main src --summary s.md  # ...and the markdown diff, uncut, in s.md
npx permlang spec src --spec x.perm               # check a .perm spec against the code
npx permlang --version                            # the installed version
npx permlang check --help                         # usage (any command)
```

In a clone of PermLang's own repository, `npm run permlang -- <command>` runs it
from source (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

Exit codes: `0` no errors; `1` permission errors, and nothing else; `2`
anything else: a usage or configuration error (a `.perm` spec that can't be
parsed included), a file that can't be read or written, or an internal error.
An internal error prints the error and where it happened, to
[report](https://github.com/PermLang/PermLang/issues).

Each command takes only its own options. Another command's option is a usage
error that says which command takes it (`check takes --json, not --format`),
since ignoring it would quietly do something else. `--help` goes on its own,
and an option's value can't start with `-`. `diff` also takes `check`'s options
except `--base` (its base is its first argument), so the GitHub Action can pass
the same `args` to both: `--json` is `--format json` there (an explicit
`--format` wins), and `--require-lock`, `--sarif`, and `--github-annotations`
don't change the diff.

With `--json`, `--github-annotations` prints the annotations on standard error,
so standard output stays valid JSON. GitHub Actions reads both.

## Using PermLang as a library

The `permlang` package is an ES module only: `import { checkFiles } from
"permlang"` works, and `require("permlang")` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`. From CommonJS, load it with
`await import("permlang")`. What it exports is in `src/index.ts`.

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
import whose types can't be found, or a call through a value typed `any`), and
when the `implements:` name matches more than one function. Rules and examples
are parsed and reported as not yet verified. See
[docs/spec-format.md](spec-format.md).

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
src/dispatch.ts     implementations reachable through interfaces, type aliases, and base classes, and functions through callable types and collections
src/units.ts        functions, methods, and files that permissions attach to, and which folders are packages
src/graph.ts        the call graph and propagation along it
src/walk.ts         walking syntax trees without recursion, and finding positions in them
src/load.ts         building the ts-morph project, setting aside files that can't be parsed
src/unmapped.ts     packages with no adapter, and imports (and `process`) with no types
src/unseen.ts       code a function reaches that has no types, for checking specs
src/unchecked.ts    the code PermLang can't check (no adapter, no types), as a lock entry
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
src/args.ts         the permlang command's options, and which command takes each
src/main.ts         the permlang command: its subcommands
src/init-workflow.ts the workflow `init --workflow` writes
src/lock-moves.ts   the lock files the PermLang Action's steps read, at a commit and in the working tree
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
