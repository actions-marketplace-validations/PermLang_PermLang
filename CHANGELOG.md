# Changelog

All notable changes to PermLang.

## 0.3.1 (2026-10-05)

### Fixed

- Tools made with the Vercel AI SDK v7's `tool()` weren't found. The SDK
  declares it in `@ai-sdk/provider-utils`, under a bundler's rename
  (`tool$1`), and `ai` re-exports it. PermLang now recognizes the `@ai-sdk/*`
  packages and ignores rename suffixes like `$1`, for tools and for adapter
  keys. `@ai-sdk/provider-utils` is covered by the AI SDK adapter, with `tool()`
  and the schema helpers touching nothing.

## 0.3.0 (2026-10-05)

This release can fail builds that passed before, when a pull request changes
what a workflow or script grants. Upgrading itself doesn't: see below.

### Added

- **Project configuration in the lock.** GitHub workflows, composite Actions,
  and `package.json` scripts are recorded like functions: their triggers, token
  permissions per job, secrets, Actions (and whether they're pinned to a
  commit), and scripts. A change that adds a permission, a secret, an unpinned
  Action, or a `postinstall` hook fails the check at that line and shows in the
  pull-request comment, until `permlang lock` records it.
- A lock written before 0.3 has no configuration in it. The first check after
  upgrading reports it as warnings, not failures; run `permlang lock` to record
  it.
- **Tools given to AI models.** PermLang finds functions registered as tools
  (Vercel AI SDK, MCP, OpenAI Agents, LangChain, and others), works out what
  each one reaches, and lists them in the report. A tool that reaches commands,
  writes, unverifiable code, a host the model can choose, or an app-level action
  like `payments.refund` gets a `PERM008` warning, since whoever controls the
  model's input can trigger it. `"tools": "error"` fails the build instead. The
  pull-request comment marks new access a model can trigger.
- **Data-flow rules.** `"flows"` in `permlang.config.json` says where protected
  data may go, such as `{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }`.
  A function that reads the source and can send to any other host, itself or
  through what it calls, is a `PERM009` error. This first version works per
  function and doesn't follow the value itself; see the reference.

### Fixed

- Declaring a tool with the Vercel AI SDK's `tool()` no longer counts as network
  access.
- The MCP adapter counted every SDK call as network access to any host. A server
  talking to its connected client (`sendLoggingMessage`, `listRoots`,
  `createMessage`, registering tools and prompts) reaches nothing; a client's
  HTTP, SSE, or WebSocket transport reaches the host it connects to, and a stdio
  transport counts as `exec`. On the official MCP example servers, this took
  the tool warnings from 10 to the 1 real one (a tool that fetches a URL the
  model chooses).
- `new URL("/path", "https://host")` with literal parts now names its host, for
  `fetch` and adapters, instead of counting as any host.

## 0.2.4 (2026-10-02)

### Added

- The permission diff and pull-request comment list **new dependencies**: each
  package the change adds to `package.json`, what PermLang sees of it (an
  adapter, declared pure, detected directly, or not checked), and its install
  scripts. A package added in a pull request can do anything its code does; now
  reviewers see it next to the new access. It doesn't fail the check.

## 0.2.3 (2026-10-02)

### Added

- Findings can go to GitHub code scanning, appearing in the repository's
  **Security** tab next to CodeQL's. On the command line, use
  `permlang check --sarif <file>`. In the Action, set `sarif: true`; the
  workflow needs `security-events: write`.
- The reference lists every diagnostic code and what it means.

### Changed

- The Action's own steps, and this repository's workflows, run GitHub Actions
  pinned to exact commits.

## 0.2.2 (2026-10-02)

The changes below were tagged as 0.2.1, but that release stopped before
publishing: a test failed only in GitHub Actions, where `GITHUB_WORKSPACE` is set.
0.2.1 was never on npm; 0.2.2 is the same release with the test fixed.

### Added

- The GitHub Action annotates each problem on its line in the pull request
  (the **Files changed** tab and the check summary), not only in the log and the
  comment. On the command line, this is `permlang check --github-annotations`.
- The JSON report records, for each capability a function reaches, the line and
  column where it reaches it (`sites`).

### Changed

- A new access the lock doesn't record (PERM005) now points at the line that
  reaches it, such as the new `fetch`, instead of the function's first line.

### Fixed

- The workflow `permlang init --workflow` writes now installs your dependencies
  before running PermLang (npm, pnpm, or yarn, from your lockfile, without
  install scripts). Without them, `@types/node` was missing in CI, so file,
  process, and environment access went unseen, with only `PERM007` warnings.
  **If you set up PermLang with an earlier version,** add `actions/setup-node`
  and an install step (`npm ci --ignore-scripts`) before the PermLang step; see
  the reference.

## 0.2.0 (2026-10-02)

This release can fail builds that passed before: code that hides a capability
behind `any` is now reported. GitHub Action users on `@v0` get this release
automatically; pin `@v0.1.2` to stay on the previous behavior while you fix
what it finds.

### Added

- Capabilities hidden behind `any` are checked where they escape, while the type
  checker still knows what the value was:
  - A member read off a cast is looked up on the original type and reported as
    the access it is, with its host or key: `(self as any).fetch(url)`,
    `(cp as any)["exec"]("ls")`, `(process as any).env.KEY`. This also applies to
    `as Record<string, any>` and to casts through `unknown`
    (`x as unknown as { exec(): void }`).
  - A capability module (`node:child_process`, `node:fs`, ...) that escapes some
    other way is unverifiable (PERM004): stored as `any`, passed to a parameter
    typed `any`, returned as `any`, read with a computed key, or a member its types
    don't declare.
  - `const f: any = fetch` counts as using `fetch`. `declare const require: any`,
    `(require as any)(...)`, and `(setTimeout as any)("code")` are checked like
    their typed forms.
- Harmless casts stay silent: a global object (`window`, `globalThis`, `process`)
  stored or passed as `any` (`const w = window as any`), members that aren't
  capabilities (`(window as any).dataLayer`, `(process as any).exit()`),
  replacing a member (`(globalThis as any).fetch = mock`), and pure modules such
  as `node:path`. On Umami (1,338 files, 278 `as any` casts, dependencies
  installed), this adds no findings.

## 0.1.2 (2026-10-02)

### Fixed

- The pull-request comment said "No permission changes" when a change added
  access without updating `permlang.lock.json`. `permlang diff` now compares the
  base against what the code reaches, and warns "Not approved yet" when the lock
  hasn't caught up. The check itself already failed; the comment now agrees.
- `window.fetch` and `self.fetch` with lib.dom or lib.webworker types weren't
  detected: they resolve to `WindowOrWorkerGlobalScope.fetch`, not the global
  function.
- `permlang <command> --help` printed an unknown-option error instead of usage.
- `permlang init` no longer says "nothing fails yet" in sketch mode, since new
  access the lock doesn't record does fail.

## 0.1.1 (2026-10-01)

### Added

- `permlang --version` (or `-v`) prints the version.

## 0.1.0 (2026-10-01)

The first release.

### Fixed (pre-release review)

An internal review before release found ways to reach capabilities with no
diagnostic. Each now has a regression fixture in `fixtures/m6/`:

- The `Function` constructor reached without naming it (`.constructor(...)`,
  `Function.apply`, `Reflect.construct(Function)`, values typed `Function`): PERM004.
- `.call`/`.apply`/`.bind` on a capability function (`fetch.call(...)`).
- URL templates whose port or userinfo came from a substitution could redirect
  to another host.
- `WebSocket`, `EventSource`, `navigator.sendBeacon`, `XMLHttpRequest`,
  `net.Socket#connect`, `http.ClientRequest`, `dgram`, `cluster`, `inspector`.
- Node's `http.request(url, { hostname })` options overriding the URL's host
  (new adapter placeholder `{host:N+}`).
- `process["env"]`.
- Setters, destructured getters, `obj["key"]` getters.
- Implicit calls: `await` (`then`), templates and string `+` (`toString`,
  `valueOf`, `Symbol.toPrimitive`), `for...of`, spreads, array destructuring.
- Exported code treated as private: `export default { ... }`, exported class
  expressions, namespaces, objects returned by exported functions.
- Casts trusted as values: string values are now traced (literals, consts, enum
  members, `as const` objects), never taken from a type.
- `permlang diff` now takes source paths (`diff <base> [paths...]`); the Action
  passes its `args`, doesn't glob-expand them, and doesn't fail on forks or when
  a comment can't be posted.
- `diff --lock` with an absolute path; a config file that isn't an object now
  exits 2.

### Fixed (second review)

A second internal review found more ways to get a wrong answer with no
diagnostic. Regression fixtures are in `fixtures/m8/`:

- The SQL table reader was rewritten to fail closed. It gave confident wrong
  answers for comma joins, quotes and comments inside names, MySQL `/*! */`
  comments, dollar quoting, and multiple statements. It now names tables only
  for statements it fully understands; anything else needs bare `db.read` and
  `db.write`.
- postgres.js fragments and helpers in a template (`${sql(table)}`, a
  fragment passed in) were read as bound values.
- Database client methods PermLang didn't list (`copyFrom`, `pragma`,
  `backup`, `sql.file`, ...) passed silently. They are now unknown database
  access; `loadExtension` is unverifiable (PERM004).
- Drizzle table names were guessed from variable names when the real name
  couldn't be read. Nested `with` relations and `migrate()` were missed.
- Text from code in the PR comment could inject Markdown or HTML; it is now
  escaped.
- Specs: an indented `perm` header was silently read as content, a second
  `implements:` replaced the first, and paths were matched case-insensitively
  on Linux.
- PERM007 missed `import x = require("x")`, literal `import("x")`, and
  packages shimmed with `declare module "x";`, whose calls are all `any`.
- The Action's hash step failed on macOS runners (no `sha256sum`), and could
  update a comment that wasn't its own.

### Added

- **Specs (phase 2 groundwork).** A `.perm` file format for rules, examples, and
  permissions (`docs/spec-format.md`), and `permlang spec`, which checks each
  spec's permissions against its implementation (SPEC001 to SPEC004). Rules and
  examples are parsed and reported as not yet verified.
- **Database clients beyond Prisma.** Drizzle (the table name comes from its
  `pgTable` / `mysqlTable` / `sqliteTable` definition) and raw SQL clients: `pg`,
  `mysql2`, `better-sqlite3`, `sqlite3`, `postgres`, Neon, and Vercel Postgres. Tables
  are read out of literal SQL; SQL built from strings needs bare `db.read` and
  `db.write`. Checked against the real packages' typings.
- **License: Apache 2.0** (`LICENSE`, `NOTICE`).
- **Package coverage.**
  - Every package called is now mapped by an adapter, declared pure
    (`adapters/pure.json`), or reported with a warning (PERM006).
    `"unmapped": "warn" | "error" | "trust"` sets the policy.
  - Imports whose types can't be found are reported (PERM007).
  - New built-in adapters: `node-fetch`, `undici`, Redis, Kafka, Bull/BullMQ,
    ClickHouse, AI SDKs, MCP, several web APIs, `@nestjs/config`, `maxmind`,
    `tar`, `dns`, `process`.
- **`permlang init`**: a sketch-level config, a first lock file, and with
  `--workflow` the GitHub workflow.
- **Programmatic API** (`import { checkFiles } from "permlang"`).
- **Getting-started guide** (`docs/getting-started.md`).

### Milestones

- **M5**:
  - strictness levels (sketch, development, production);
  - `permlang.lock.json` and `permlang lock`;
  - PERM005 when code gains access the lock doesn't record;
  - `permlang diff` as text, JSON, or a pull-request comment;
  - the GitHub Action;
  - a real-world trial on Umami and Ghostfolio (`docs/trial-2026-09.md`), with fixes:
    - `const` records in computed calls;
    - `require()` of harmless modules;
    - Prisma clients built with `$extends`;
    - relative module augmentations.
- **M4**:
  - an adversarial suite: functions used as values, interface and override
    dispatch, constructors and field initializers, computed calls, module side
    effects;
  - unverifiable code (PERM004): `eval`, `new Function`, computed calls on
    sensitive objects, `require`, `import(variable)`, `vm`, workers;
  - known limits as fixtures that fail once fixed.
- **M3**:
  - `env`, `exec`, `db` (Prisma), and `http`/`https`/`net`/`tls` detection;
  - adapter manifests, with built-ins for axios, Stripe, and nodemailer;
  - `@perm-unsafe`.
- **M2**:
  - propagation through the call graph across files, with call paths in errors;
  - module-level `@perm`.
- **M1**:
  - `@perm` annotations;
  - direct `fetch` and `fs` detection;
  - `permlang check`.
