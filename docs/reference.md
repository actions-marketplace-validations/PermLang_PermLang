# PermLang reference

The details behind the [README](../README.md): what PermLang detects, how
capabilities match, adapters, the lock file, the GitHub Action, the CLI, and what
it can't see yet. New here? Start with [getting started](getting-started.md).

## What it checks

- **Annotations.** `@perm` tags in JSDoc on functions, methods, constructors,
  accessors, and function-valued `const`s and properties.
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

- **Missing annotations.** At the default strictness, an exported function
  with no `@perm` is an error (PERM003) for each capability it reaches. Private
  helpers need no annotation; their callers must cover what they use. See
  [Strictness levels](#strictness-levels).
- **All v0.1 capabilities.**
  - `env`: any expression typed `NodeJS.ProcessEnv`, so `process.env.KEY`,
    `process.env["KEY"]`, destructuring, `"KEY" in process.env`, and aliases
    (`const env = process.env; env.KEY`). Spreading or enumerating the
    environment needs bare `env`.
  - `exec`: `child_process` (`exec`, `execFile`, `spawn`, `fork`, and their
    `Sync` forms).
  - `net`: also `http`, `https`, `http2`, `net`, and `tls` (host from a URL or
    from an options object's `hostname` / `host`).
  - `db`: **Prisma** (open question 2, provisionally answered). The table is the
    model's accessor name: `prisma.lead.create()` needs `db.write(lead)`. Raw
    SQL (`$queryRaw`, `$executeRaw`, ...) needs bare `db.read` and `db.write`.
  - `db`: **Drizzle**. The table is the name given to `pgTable` / `mysqlTable` /
    `sqliteTable`: `db.insert(auditLog)`, with `const auditLog = pgTable("audit_log", ...)`,
    needs `db.write(audit_log)`. `pgSchema("s").table("t")` is `s.t`, and `alias(t)`
    is `t`. A name PermLang can't read (computed, from `pgTableCreator`, or held in a
    `let`) could be any table. `.from()` and joins read. `db.query.<key>.findMany()`
    reads `<key>` and each `with` relation, nested ones included; options that
    aren't written out could load any. `db.execute()` is raw SQL, and `migrate()`
    can touch any table.
  - `db`: **raw SQL clients** (`pg`, `mysql2`, `better-sqlite3`, `sqlite3`,
    `postgres`, `@neondatabase/serverless`, `@vercel/postgres`). When the query
    is literal text, its tables are read out of it: `SELECT ... FROM leads JOIN
    teams` needs `db.read(leads), db.read(teams)`. Tagged templates (`` sql`...` ``)
    count, because their substitutions are bound parameters, unless a substitution
    is itself SQL (a postgres.js fragment or `sql(name)` helper). The reader fails
    closed: it names tables only for a single `SELECT`, `INSERT`, `UPDATE`, or
    `DELETE` it fully understands. Anything else (`WITH`, `UNION`, DDL, `COPY`,
    `PRAGMA`, dialect-specific quoting or comments, more than one statement) can
    touch any table, as can SQL built with string concatenation or a template passed
    to `query()`; these need bare `db.read` and `db.write`. So does any client
    method PermLang doesn't know, so new APIs can't pass silently. Schema-qualified
    names are declared as written (`db.read(public.users)`).
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
    `paths.forEach(unlinkSync)`, `send.call(...)` (a `const` alias is fine,
    because calls through it resolve to the original);
  - calls through an interface or base class, which reach every first-party
    implementation, including object literals written against the type;
  - `super()`, implicit constructors, and instance field initializers;
  - `{ helper }` shorthand, getters, and literal computed keys (`api["ping"]()`);
  - computed keys over a known object (`handlers[kind]()`), which reach every
    member the key allows;
  - importing a module, which runs its top-level code (static and literal
    `import()`).
- **Unverifiable code (PERM004).** Code whose effects can't be determined is
  an error in annotated functions: `eval`, `new Function`, `setTimeout("code")`,
  `require()`, `import(variable)`, `vm`, `new Worker`, and computed calls on
  sensitive objects (`fs[method]()`, `globalThis[name]()`) or behind an index
  signature (`table[name]()`). The only way to accept it is `@perm-unsafe`,
  which also stops it from failing the function's callers.
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

### Known limits

Design doc §12 asks the checker to catch the whole adversarial suite, or to
document each miss. These misses are documented as fixtures in
[`fixtures/m4/limits/`](../fixtures/m4/limits) and [`fixtures/m6/limits/`](../fixtures/m6/limits),
and as "known misses" in the adversarial suite
([`test/adversarial.test.ts`](../test/adversarial.test.ts)), which also lists
the harmless code that must stay silent. Each miss's test fails once it's fixed,
so the list can't go stale.

- Values typed `any`: nothing called on them can be resolved. Where a value
  with known capabilities becomes `any`, the escape itself is checked:
  - A member read off a cast is looked up on the original type and reported as
    the access it is: `(globalThis as any).fetch(url)`,
    `(childProcess as any)["exec"](cmd)`, `(process as any).env.KEY`. Casts to
    `Record<string, any>` and through `unknown` count too.
  - A capability module that escapes any other way (stored, passed, or returned as
    `any`, or read with a computed key) is unverifiable (PERM004).
  - `const f: any = fetch` counts as using `fetch`, and `declare const require: any`
    and `(require as any)(...)` are still `require`.

  Two things stay unchecked. A global object stored as `any`
  (`const w = window as any; w.fetch(url)`) isn't followed: that cast is common
  and almost always harmless, so it isn't reported. And a value that was `any`
  from the start, such as an untyped parameter, has nothing to trace. Imports
  whose types can't be found, including packages shimmed with
  `declare module "x";`, are reported (PERM007), whether reached by `import`,
  `import x = require()`, or a literal `import()`.
- `Proxy` traps, which can return a capability function for any property.
- Functions attached after the fact (`obj.m = fn`, reassigning a `let`) aren't
  linked to calls through that property or variable. The top-level code that
  assigns them is still reported.
- Implicit calls made inside a library function: `Promise.resolve(x)` calling
  `then`, `Array.from(x)` running an iterator, `String(x)` calling `toString`.
  Written directly (`await x`, `for...of`, `${x}`, `"" + x`), they're caught.

Other gaps, not yet in fixtures:

- Third-party packages without an adapter: what they touch is trusted. They are
  listed in every report and warned about (PERM006; see below).
- A `ProcessEnv` received as a parameter typed as a plain object.
- A decorator's arguments run when the class is defined, but are charged to the
  decorated member.
- Lock keys for same-named functions in one file (`#2`, `#3`) follow source
  order, so adding one can renumber the others and show spurious lock changes.

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

## Diagnostic codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `PERM001` | error | A function reaches a capability its `@perm` doesn't declare. |
| `PERM002` | error | An `@perm` annotation is invalid. |
| `PERM003` | error | A function that must declare its permissions has no `@perm`: exported functions at development, every function at production. See [strictness levels](#strictness-levels). |
| `PERM004` | error | Code whose effects can't be determined statically, such as `eval` or a capability hidden behind `any`. |
| `PERM005` | error, or warning when access was removed | The code reaches something `permlang.lock.json` doesn't record, or no longer reaches something it does. |
| `PERM006` | warning, by default | A call into a package with no adapter: what it touches isn't checked. See [packages without an adapter](#packages-without-an-adapter). |
| `PERM007` | warning, by default | An import whose types can't be found, so nothing called from it is checked. |
| `PERM008` | warning, by default | A tool an AI model can call reaches something dangerous. See [tools given to AI models](#tools-given-to-ai-models). |
| `PERM009` | error | A function reads data a flow rule protects and can send it somewhere the rule doesn't allow. See [data-flow rules](#data-flow-rules). |
| `SPEC001`–`SPEC004` | error or warning | Problems with `.perm` specs: see [specs](#specs-phase-2-groundwork). |

Sketch strictness reports everything but fails only on `PERM005`.

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
`` `./data/${name}` ``. *(Provisional: this answers open question 1 in the design
doc and may change after review.)*

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

A function that reads the `from` capability directly, and can send to a host
`to` doesn't list, is a `PERM009` error. That covers sending itself or through
anything it calls, and a host that can't be determined (`fetch(url)`). The
error points at the call that leads there:

```
src/billing.ts:7:9 error PERM009: charge reads env(STRIPE_KEY) and can send to net(analytics.example),
  through track → fetch("https://analytics.example/event", ...), which the flow rule for env(STRIPE_KEY) doesn't allow.
```

A `from` without a scope covers a whole category: `"env"` protects every
environment variable. Reading the whole environment (`JSON.stringify(process.env)`)
counts as reading every variable.

**This first version works per function.** It doesn't follow the value itself:
a key read into a module-level constant and used by another function isn't
caught, and neither is one passed to a callee as an argument. Callers of a
function that reads the key aren't flagged, since the key stays inside it. Only
network hosts are checked as destinations.

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
| Vercel AI SDK (`ai`) | `tool({ execute })`, `dynamicTool(...)` |
| MCP (`@modelcontextprotocol/sdk`) | `server.tool(name, ..., handler)`, `server.registerTool(name, config, handler)`, and `setRequestHandler(CallToolRequestSchema, handler)`, which serves every tool (named `*`) |
| OpenAI Agents (`@openai/agents`) | `tool({ name, execute })` |
| LangChain (`@langchain/core`, `langchain`) | `tool(func, ...)`, `new DynamicStructuredTool({ func })`, and other `new ...Tool(...)` classes |
| Anthropic, Mastra, LlamaIndex | their `tool`/`createTool`/`betaTool`-style helpers with an `execute`, `run`, or `func` handler |

Every tool is listed in the report, with what it reaches. When a tool reaches
something a model shouldn't trigger unchecked, there's a `PERM008` warning at
the registration:

- running commands (`exec`) or code that can't be verified;
- writing files or data (`fs.write`, `db.write`);
- sending to a host that isn't fixed (bare `net`), since the model can choose
  where data goes;
- app-level actions from adapters, such as `payments.refund` or `email.send`.

Reading files, tables, environment variables, or a fixed host doesn't warn: that's
what tools are for. Set `"tools"` in `permlang.config.json` to `"error"` to fail
the build instead, or `"trust"` to only list them.

In the pull-request comment, new access a tool can reach is marked *An AI model
can trigger this*, with the tool's name.

A handler PermLang can't find (passed in from elsewhere, say) counts as
unverifiable. Tools registered through a wrapper of your own aren't recognized
yet.

## Project configuration

Workflows and scripts grant as much as code does, and AI agents edit them as
readily. So the lock also records, for the folder it lives in:

- **GitHub workflows** (`.github/workflows/*.yml`), and **composite Actions**
  (`action.yml`, `.github/actions/**/action.yml`);
- **`package.json` scripts.**

Each file is an entry in the lock, keyed by its path (for example
`.github/workflows/ci.yml#<ci.yml>`), and what it grants are its capabilities:

| Capability | Meaning |
| --- | --- |
| `ci.trigger(event)` | An event the workflow runs on, such as `pull_request_target`. |
| `ci.permission(scope: level)` | A token permission a job gets, from its own `permissions:` or the workflow's. `ci.permission(write-all)` and `ci.permission(read-all)` for the shorthands; `ci.permission(default)` when neither sets any, so the token gets the repository's default, which can be write access to everything. |
| `ci.secret(NAME)` | A secret the file reads (`secrets.NAME`). `ci.secret(inherit)` for `secrets: inherit`; `ci.secret(all)` for `toJSON(secrets)`. |
| `ci.action(owner/repo)` | An Action or reusable workflow a step or job runs (`uses:`). |
| `ci.unpinned(owner/repo)` | ...referenced by a tag or branch rather than an exact commit, so what runs can change without a change here. |
| `npm.script(name: command)` | A `package.json` script and its command, lifecycle hooks such as `postinstall` included. |
| `ci.unverifiable`, `npm.unverifiable` | A file PermLang can't parse. It's recorded rather than skipped, so it can't hide anything. |

A change that adds one fails the check (`PERM005`) at the line that grants it,
and shows in the pull-request comment, until `permlang lock` records it. That's
the same review gate as for code. Updating a pinned Action to a new commit
doesn't change the lock, but switching it to a tag does. Steps' `run:` commands
aren't recorded yet.

**Upgrading from 0.2:** a lock written before 0.3 records no configuration. The
first check after upgrading reports each entry as a warning instead of failing,
and `permlang lock` records them.

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

`default` applies to every other method in the package (not constructors). An
empty list maps a function to nothing. Add your own adapters in
`permlang.config.json`; they take precedence over the built-in ones:

```json
{ "adapters": ["./permlang/adapters/acme-sms.json"] }
```

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
`maxmind`, `tar`, and the Node modules that carry capabilities. Where an
adapter can't know a service's hosts, it uses bare `net`. PermLang runs itself
with `"unmapped": "error"` and a team adapter for ts-morph (see
[`permlang.config.json`](../permlang.config.json)).

## Strictness levels

Set `"strictness"` in `permlang.config.json`, or pass `--strictness`:

| Level | What fails |
| --- | --- |
| `sketch` | Nothing. Every function's permissions are inferred and reported. Start here on an existing codebase. |
| `development` (default) | Annotated functions that exceed their `@perm`, invalid annotations, unverifiable code, and exported functions or top-level code without `@perm`. |
| `production` | All of the above, plus any function (private helpers too) that reaches something without being covered by function- or module-level `@perm`. |

## The lock file and the permission diff

`permlang lock` writes `permlang.lock.json`: what every function can reach, and what
every workflow, Action, and `package.json` script grants. Commit it. From then on:

- **`permlang check` fails when the code reaches something the lock doesn't
  record** (PERM005), at every strictness level, sketch included. New access
  can't land without the lock changing, so it always shows up in review. The
  error points at the line that reaches the new access, such as the new `fetch`
  or the call into a helper that makes it. Access that was removed is a warning:
  the lock is stale, but nothing new can happen.
- **`permlang diff <base-ref> [paths...]` shows what changed since `base-ref`**, one row per
  new capability, with where it happens and which functions can now reach it:

  | New access | Where it happens | Now reachable from |
  | --- | --- | --- |
  | `+ net(api.data-broker.io)` | `scoreLead`<br>axios.post("https://api.data-broker.io/v2/enrich", ...) | `scoreLead`, `handleLead` |

  The diff compares `base-ref`'s lock with what the code reaches now, not only
  with the lock file on disk. When the code reaches access the lock doesn't record
  yet, the diff still lists it and adds a **Not approved yet** warning until
  `permlang lock` is run and committed. With `--head <ref>`, it compares two
  committed lock files.

  The diff also lists **new dependencies**: packages the change adds to
  `./package.json`, in `dependencies` or `devDependencies`. For each one, it says
  what PermLang sees (checked by an adapter, declared pure, detected directly, or
  **not checked** because it has no adapter) and lists its `preinstall`,
  `install`, and `postinstall` scripts when it's installed. It's there for review:
  a new package doesn't fail the check, although calls into one with no adapter
  get a `PERM006` warning.

`--format markdown` produces the pull-request comment; `--format json` is for
tools, and includes `unrecorded` (the access the lock doesn't record yet, or
`null`) and `dependencies`.

The check compares against `./permlang.lock.json` whenever it exists. When
checking other files from the same folder (like the fixtures here), pass
`--no-lock`.

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

The Action runs `permlang check`, fails the build on errors, and posts the
permission diff as a pull-request comment, updating it on later pushes. Each
problem also appears as an annotation on its line in the pull request's
**Files changed** tab, and in the check's summary. GitHub shows up to 10 error
and 10 warning annotations per step; the full list is in the log and the
comment. This repository runs it on itself (see
`.github/workflows/permlang.yml` and `permlang.lock.json`).

`@v0` follows the latest 0.x release. A minor release (0.2, 0.3, ...) can
detect more and fail builds that passed before; the [changelog](../CHANGELOG.md)
says when. To upgrade on your own schedule, pin an exact release instead, such
as `PermLang/permlang@v0.2.0`.

**Code scanning.** Set `sarif: true` to also upload the findings to GitHub code
scanning, where they appear in the repository's **Security** tab next to
CodeQL's, and close on their own once fixed. The workflow needs
`security-events: write` in its `permissions:`. The upload is best effort: on a
pull request from a fork, whose token is read-only, it's skipped and the check
still runs.

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
npm run permlang -- diff origin/main               # permission changes since main
npm run permlang -- spec src                       # check .perm specs against the code
npm run permlang -- --version                      # the installed version
npm run permlang -- check --help                   # usage (any command)
```

Exit codes: `0` no errors, `1` permission errors, `2` usage or configuration error.

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
actually reaches. Rules and examples are parsed and reported as not yet verified.
See [docs/spec-format.md](spec-format.md).

## Real-world trial

[docs/trial-2026-09.md](trial-2026-09.md): PermLang on Umami (1,372 files, 22 s)
and Ghostfolio's API (524 files, 9 s). It found and fixed three false-positive
classes and one false-negative class (Prisma clients built with `$extends`),
found no false positives in a spot check of its network, process, and file-write
findings, and identified the main remaining false negative: SDKs without
adapters. Run `prisma generate` before PermLang in CI, or database access is
invisible.

## Development

Tests come first. Each rule in the design doc gets passing and failing fixtures
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
src/detect/         direct uses: fetch, fs, env, Prisma, Drizzle, SQL, adapter-mapped calls, values, unverifiable code
src/dispatch.ts     implementations reachable through interfaces and base classes
src/units.ts        functions, methods, and files that permissions attach to
src/graph.ts        the call graph and propagation along it
src/unmapped.ts     packages with no adapter, and imports with no types
src/project-files.ts workflows, Actions, and package.json scripts, as lock entries
src/tools.ts        tool registrations for AI models, and their handlers
src/flows.ts        data-flow rules: parsing, and finding functions that break them
src/deps.ts         new dependencies in a change
src/check.ts        comparing declared vs. actual per unit
src/lock.ts         permlang.lock.json: build, read, compare
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
