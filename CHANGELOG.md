# Changelog

All notable changes to PermLang.

## 0.4.3 (2026-10-07)

**A security release**, for workflows that 0.4.2's `permlang init --workflow`
wrote, or that follow 0.4.2's [reference](docs/reference.md#github-action). Add
`if: always()` to the check's job, beside `needs: dependencies`:

```yaml
  permissions:
    needs: dependencies
    if: always()
```

Or delete `.github/workflows/permlang.yml` and run
`npx permlang@0.4.3 init <your paths> --workflow` again. Nothing that passed
with 0.4.2 fails with 0.4.3.

### Security

- **A failed install skipped the check (low,
  [GHSA-86ff-3f4h-rrjp](https://github.com/PermLang/PermLang/security/advisories/GHSA-86ff-3f4h-rrjp)).**
  0.4.2's workflow runs the check in a job after the one that installs the
  dependencies. When that job fails, GitHub skips the check's job, and counts a
  skipped job as passed, also as a required check. Code the pull request runs
  while installing could fail that job on purpose, and only that job, so the
  pull request could merge without a check. The check's job now runs always,
  and fails when there are no dependencies to download, saying why.

### Fixed

- **The rule for moved lock files** counts a step whose job has
  `if: always()` or `if: !cancelled()` as sure to run: it runs even when a job
  it needs fails.

### Project

- **PermLang's own `released` check** installs its dependencies in a job of
  its own, as `init`'s workflow does, and runs 0.4.2.

## 0.4.2 (2026-10-07)

**A security release.** It fixes four vulnerabilities, two of them high
severity. `@v0` users get the Action's fixes automatically, but the most
serious one needs a change to your workflow, in two cases:

- your workflow installs dependencies, builds, or runs tests in the same job as
  the PermLang Action, before it;
- `permlang init --workflow` wrote it (before 0.4.2, it did exactly that).

In either case, a pull request can change the check's result. Delete
`.github/workflows/permlang.yml` and run
`npx permlang@0.4.2 init <your paths> --workflow` again, or split it into two
jobs as the [reference](docs/reference.md#github-action) shows. Nothing that
passed with 0.4.1 fails with 0.4.2, unless a setting in `permlang.config.json`
isn't text ([below](#fixed)).

### Security

- **Installing ran in the check's job (high,
  [GHSA-chh9-p8fq-3gf9](https://github.com/PermLang/PermLang/security/advisories/GHSA-chh9-p8fq-3gf9)).**
  The workflow `init --workflow` wrote installed the dependencies in the same
  job as the check, before it. Installing runs code the pull request controls,
  even with install scripts off:
  - pnpm loads `.pnpmfile.cjs`;
  - Yarn 2 and later run `yarnPath` and its plugins;
  - npm runs the program a project `.npmrc` names as `git`.

  That code could change what the check runs or reports. The workflow now has
  two jobs:
  - **`dependencies`** installs with a read-only token, packs every
    `node_modules` folder, and uploads them.
  - **`permissions`** runs nothing from the pull request. It brings in the
    packed folders with the Action's new `dependencies` input, which refuses
    the whole archive if it has anything else, a link out of the repository or
    into `.git`, or a folder the checkout already has.

  Code generated outside `node_modules` (a Prisma client in `src/generated`,
  say) can come along through the new `generated` input.
- **The Action's build cache could be replaced on a pull request (high,
  [GHSA-2vhg-398w-7p59](https://github.com/PermLang/PermLang/security/advisories/GHSA-2vhg-398w-7p59)).**
  The Action restored its own build from the Actions cache and ran it unchecked.
  For a pull request, GitHub looks first in the pull request's own cache, which
  any of its jobs can write to. So code from the pull request (its tests, say)
  could put a build of its own there, which would then run instead of PermLang.
  The cache is now used only for pushes, and scheduled and manual runs. Pull
  requests and merge queue entries build PermLang from its sources every time,
  which takes about half a minute.
- **A step that never runs kept a moved lock from failing the check (moderate,
  [GHSA-h4jc-gqvh-2675](https://github.com/PermLang/PermLang/security/advisories/GHSA-h4jc-gqvh-2675)).**
  The rule for moved locks (since 0.4.0) let a pull request off when any
  PermLang step still read the base's lock, even one with `if: false`. Now only
  a step that's sure to run counts:
  - its workflow runs on every pull request;
  - no `if:` on the step, its job, or a job its job needs;
  - its failure isn't ignored (`continue-on-error:`).
- **A file path could inject workflow commands into the job log (low,
  [GHSA-86xw-2f2v-g8vw](https://github.com/PermLang/PermLang/security/advisories/GHSA-86xw-2f2v-g8vw)).**
  A checked file in a top-level folder named `::stop-commands::x` started a line
  of the report that the runner obeyed, hiding the annotations after it. In
  GitHub Actions, PermLang now tells the runner to ignore commands, until a
  token only that run knows, while it prints.

### Fixed

- **The pull-request comment could go on showing an earlier push's diff** when
  `permlang diff` died without printing anything (out of memory, or stopped).
  The comment step now fails instead.
- **A capability named `constructor`** (or another name every JavaScript object
  has), which an adapter can define, made the diff's comment and text output
  throw.
- **An added dependency named `../x`** made the diff read `x/package.json`, and
  show its install scripts. A name npm wouldn't allow is now treated as not
  installed.
- **Tens of thousands of `@perm` tags in one comment, or of `package.json`
  scripts,** took minutes to read: 50,000 took 70 and 34 seconds. Both now take
  well under a second.
- **A setting in `permlang.config.json` that isn't text** was read as text, so
  `"unmapped": ["error"]` worked as `"unmapped": "error"`. It now stops the
  check with the usual message listing the allowed values (exit code 2).

### Project

- **Each release comes with an SBOM**: a CycloneDX list of every package
  installing PermLang installs, signed by the release workflow and attached to
  the GitHub release ([SECURITY.md](SECURITY.md#whats-in-a-release-sbom)).
- **Anyone can rebuild a release** from its tag and get the same package, byte
  for byte; CI checks that building twice gives the same result
  ([SECURITY.md](SECURITY.md#rebuilding-a-release)).
- **Every pull request is also checked by:**
  - ESLint, with typescript-eslint's type-aware rules;
  - a review of its new and updated dependencies, which fails on a known
    vulnerability or a license PermLang can't use;
  - a check that each commit is signed off by its author
    ([CONTRIBUTING.md](CONTRIBUTING.md#signing-off)).
- Every source file starts with its license, and a test keeps hidden and
  bidirectional characters out of them.
- [docs/policies.md](docs/policies.md) writes down how dependencies are chosen,
  which findings block a merge, how secrets are kept, and what every change
  must include.

## 0.4.1 (2026-10-06)

Nothing that passed with 0.4.0 fails with 0.4.1.

### Fixed

- **The pull-request comment said "Check settings changed" twice** when the
  check's settings were the only change, as on the first pull request after
  upgrading a lock from 0.3, and "New code PermLang can't check" twice when
  that was the only change. It now says each once.

### Project

- **PermLang's own pull requests are also checked by its last release**, pinned
  to its commit, which a pull request can't change. Before, they were checked
  only by their own copy of PermLang, so a pull request could change how its
  own new access was judged. See [CONTRIBUTING.md](CONTRIBUTING.md).
- Tests clean up their temporary folders in a way that tolerates Windows
  holding a folder open for a moment, which occasionally failed a test run.

## 0.4.0 (2026-10-06)

This release fixes the problems a full code review of 0.3 found, and the ones a
second, independent round of testing then found in those fixes: ways a pull
request could add access without the check failing or the comment showing it,
and access the analysis didn't see. It reports more than 0.3 did, and it's
stricter about the lock.

**Upgrading: every existing lock fails once.** The first check after upgrading
fails with a single error, `permlang.lock.json was written by an older
PermLang (lock format 1)`. Run `permlang lock` once, with the paths and
options your check uses, review the changes, and commit them. That includes
GitHub Action users on `@v0`, who get 0.4.0 automatically. If you also run
PermLang from npm, update it first (`npm install --save-dev permlang@^0.4.0`):
`^0.3` never installs 0.4, and 0.3 can't read a 0.4 lock. See
[upgrading from 0.3](docs/reference.md#upgrading-from-03-or-earlier).

### What newly fails

- **The lock must match the code exactly.** Access the lock records but the
  code doesn't reach is an error, not a warning, so deleting or moving a
  function needs a relock. New, removed or reworded `@perm-unsafe` overrides
  are errors too.
- **The lock records more, and a change to any of it fails until relocked:**
  - the settings: strictness, `unmapped`, `tools`, each flow rule, and each
    adapter, whether set in `permlang.config.json`, on the command line, or in
    the Action's inputs;
  - which files are checked, including the project's own files the checked
    paths import from elsewhere (`../lib`, `scripts/`);
  - the TypeScript project's `include`, `exclude` and `files`, and the compiler
    options that decide what an import is (`module`, `esModuleInterop`, ...),
    with the values TypeScript actually uses;
  - the code PermLang can't check: packages with no adapter and imports with no
    types. A new one fails even with `"unmapped": "trust"`.
- **More access is reported** (see below). Each new finding shows as new access
  until the lock records it. Some results are bare instead of scoped, because
  the code can redirect them: `fetch(url, init)` with an `init` that isn't
  written out, an http agent other than Node's own, mysql2 `query()` values
  typed by an interface.
- **The Action fails a pull request that stops checking with the base commit's
  lock file**, for example by changing `--lock` in `args` or the
  `working-directory`. To move a lock, add a check for the new one first, then
  remove the old one in a later pull request. A pull request that deletes the
  lock fails too.
- **Each command rejects options it doesn't take**, with exit 2 and the right
  option's name (`check takes --json, not --format`). `--help` must be used on
  its own.
- **Flow rules:**
  - An adapter's action, such as `email.send`, is a place data goes: list it in
    `"to"` to allow it. An action no adapter defines is a configuration error.
  - A function holding the protected data that calls into a package with no
    adapter, or an import with no types, fails: PermLang can't see where that
    code sends it.
  - Data a function writes into an object its caller passed in (headers filled
    in by a helper) is followed.
  - Code in `@perm-unsafe` functions counts.
  - A host written with a scheme, port or path (`net(https://api.stripe.com)`)
    is a configuration error that says what to write.
- **Explicit rules fail at sketch strictness.** Only the annotation rules
  (PERM001 to PERM004) are relaxed at sketch. A broken flow rule (PERM009),
  `"tools": "error"` and `"unmapped": "error"` now fail there too.
- **Exit code 2 for everything that isn't a permission error:** a missing
  `--lock` file you named, unknown config keys, a broken `tsconfig.json` or one
  that selects no files, paths with no TypeScript files, malformed `.perm`
  specs, and crashes (which exited 1).
- **Specs:** an implementation PermLang can't fully see, including one that
  calls through `any`, is "unchecked" (new SPEC005, an error) instead of
  "perms ok", and a name matching more than one function fails.
- **`init --workflow`** refuses paths outside the repository or ones the Action
  can't read.
- **Node 20.1 or later** is required (`engines`). On 20.0, only top-level files
  were checked.

### Fixed: the review gate

- **Editing only the lock approved access in advance.** A pull request could add
  `exec` to a function in the lock with no code change, and a later one could
  add the `execSync` call; both passed with "No permission changes". The lock
  must now match the code exactly.
- **Narrowing what's checked hid code.** Removing a file from `tsconfig.json`'s
  `include`, or calling into a file outside the checked paths, passed. The lock
  now records which files are checked, follows imports out of the paths, and
  records the compiler options that change what an import is.
- **Deleting the lock, or pointing the Action at another one, turned the check
  off.** The Action now checks against the base commit's lock (new
  `check --base <ref>`, which the Action passes), and the comment says when a
  pull request deletes or abandons it.
- **A pull request could trigger the 0.3 upgrade grace period** by removing the
  lock's configuration entries. There's no grace period any more.
- **A pull request's own config could loosen the check unseen.** Settings are
  recorded, and changes are listed in the comment under "Check settings
  changed".
- **New code PermLang can't see only warned.** A new package with no adapter, a
  folder of the project's own with its own `package.json`, or an import with no
  types now fails until the lock records it, and the comment lists it under
  "New code PermLang can't check".
- **The comment:**
  - the new-access table comes first, every value is cut to 500 characters, and
    one long row can no longer push the others out;
  - it stays under GitHub's size limit, and the job summary gets the full diff
    (new `diff --summary <file>`);
  - when it can't be updated, the step fails instead of leaving a stale comment
    up;
  - when the check stopped with an error, or the code couldn't be analyzed, it
    says so first, never "No permission changes";
  - each folder in a monorepo gets its own comment, and folders such as `.web`
    and `web` no longer share one;
  - the Action finds its comment by its token's own account, and never edits
    anyone else's.
- **Text from code is escaped everywhere:** the comment, `permlang spec`,
  adapter errors and GitHub annotations. It can't inject workflow commands,
  mention people, create links, or hide text with control characters.
- **Dependencies:** optional and peer dependencies are listed, and so are
  packages switched to an alias, URL or git source, and new or changed
  `overrides`, `resolutions` and `pnpm.overrides`.
- **Crashes:** a lock key named `toString`, a numeric dependency version, and a
  lock with merge-conflict markers (`permlang lock` now replaces it, with a
  warning).
- **The Action** no longer changes the Node version for your job's later steps
  on GitHub-hosted runners, no longer makes a full clone shallow, honours a
  custom `--lock` in `args`, and its cache saves on Windows.

### Fixed: access that went unreported

- **Loading modules.** `import()` and `require()` with a module name held in a
  constant, an `as const` object or an enum are traced. A module that runs
  commands, touches files or queries a database is unverifiable, and so is one
  that can't be traced. `data:`, `http(s):`, `blob:` and `file:` imports are
  unverifiable. `require` used as a value (`Reflect.apply(require, ...)`,
  `map(require)`) is unverifiable. `require()` of an asset-looking file
  (`./theme.css`) follows Node's real rules: it runs as JavaScript.
- **JavaScript behind your own `.d.ts`.** Calls into it are unverifiable instead
  of silently trusted.
- **Functions used as values.** `const run = execSync; run.call(null, "id")`,
  `const { exec } = cp; promisify(exec)`, `const get = fetch; urls.map(get)`,
  and functions inside a larger `export default` are reported, and so are
  constructors reached through an alias, a subclass, a parameter or
  `Reflect.construct`. Feature checks like `if (globalThis.fetch)` don't count
  as uses.
- **Hosts are read the way Node reads them.** The http family connects to
  `hostname` before `host`. Options that redirect a connection make the host
  unknown (bare `net`): a spread, `socketPath`, `lookup`, a different host in
  `tls.connect` or `http2.connect` options, an http `agent` other than Node's
  own, and fetch's `dispatcher`.
- **Node APIs that were never matched:** `process.kill`, `process.dlopen`,
  `cluster.fork` and other process and cluster functions; `process.execve`,
  `process.loadEnvFile`, `process.binding`, `process.report.writeReport`,
  `module.register`, `module.enableCompileCache`, the inspector's
  `Session.post`, `crypto.setEngine`, and `getBuiltinModule` with a computed
  name. A test now checks every key in the Node adapters against @types/node.
- **Calls through interfaces** reach every class or object that could stand in
  for the interface, including ones without `implements`. Calls through a
  callable type, or through a collection of functions (`Map<string, () =>
  void>`, `Handler[]`), reach the functions written against it.
- **Entry points:** `export default withAuth(handler)`, `export default { fetch
  }`, `export =`, nested namespaces, and route tables, plugin hooks and AI tools
  handed to a call are checked like exported functions.
- **Hidden calls:** decorators, getters run by spreading or destructuring,
  `valueOf` in arithmetic, `yield*`, `using`, `instanceof`, and classes built
  by functions or mixins.
- **Browser:** WebSocket, EventSource and WebTransport through aliases and
  subclasses, `navigator.sendBeacon.call(...)`, timers that may run a string,
  and the browser's `Worker`, `SharedWorker`, `importScripts`, service workers
  and worklets (unverifiable).
- **Files:** `readFile` with a writing `flag`, and streams with a writing
  `flags`, are writes, read the way Node reads each option; `fchmod`, `fchown`,
  `futimes` and `WriteStream` are writes; `process.chdir(dir)` needs access to
  `dir`. On Windows, `/` no longer covers a network share, `.` no longer covers
  `C:..\x`, and `..` can't climb out of a share.
- **Environment variables:** `import.meta.env.X` is `env(X)`; env read through
  nested destructuring (`const { env: { KEY } } = process`) is read by name;
  and `process.env.X` is still found without @types/node, with a warning.
- **Constants the program changes.** `as const` objects and enums written
  anywhere (`Object.assign` however it's reached, `defineProperty`, a method
  writing `this`, namespaces, CommonJS exports) no longer count as constants.
- **Capability modules cast to `any`** in more ways: `import x = require()`,
  `await import()`, re-exports, `Object.values(cp)`, computed reads, copies made
  with a spread, modules passed as `unknown`, `{}`, `this` or a generic
  parameter, and functions or classes called past the cast. A default import
  that the compiler options give no default export is followed too.
- **Databases:**
  - Prisma was recognized by the word "prisma" in a file's path, which turned
    unrelated calls into database access. It's now recognized only by its own
    package or a generated client's runtime import.
  - The SQL reader could return a narrower answer than the query
    (`INSERT INTO leads (SELECT * FROM secrets)` read nothing; `?FROM secrets`
    hid the keyword). It now returns "unknown" (bare `db.read`/`db.write`)
    whenever it can't be sure, reads placeholders the way each database does,
    and very deep nesting no longer crashes it.
  - Prisma relations (`include`, `select`, `where`, nested writes, the fluent
    API), query extensions, `findRaw`/`aggregateRaw`, `prisma[model]`, and
    methods used through `.call` or as values are read.
  - Drizzle `` sql`…` `` fragments, `sql.raw()`, `StringChunk`, `new SQL`,
    `sql.fromList`, and the SQL `$defaultFn`/`$onUpdateFn` add to inserts and
    updates are read.
  - mysql2 values that could carry a `toSqlString()` method need bare access.
  - Node's built-in `node:sqlite` is checked like better-sqlite3, and a database
    client cast to `any` is followed.
- **Adapters:** Stripe clients configured with a `host`, and Stripe's other
  hosts; tar extraction, including tar 7's `syncFile`/`asyncFile` functions (a
  write); cheerio `fromURL` and rxjs `ajax`, `fromFetch` and `webSocket`
  (network); react-dom `preinit` and lodash `template` (unverifiable).
- **Very deep or large code** is analyzed instead of crashing the check, and a
  file that can't be analyzed is unverifiable instead of stopping the run.
  Propagation is linear: a 16,000-function call chain takes about 6 seconds
  instead of 30.
- **Files on more than one drive.** On Windows, a check given files on more
  than one drive (through the library's `checkFiles`, or folders on two drives
  on the command line) left some of them out without a word. Every file given
  is now checked.

### Fixed: workflows and `package.json` scripts

- **YAML anchors hid everything** a workflow granted: its trigger, permissions
  and Actions. Aliases are now resolved.
- **Invisible line breaks could hide a secret.** GitHub's runner treats U+0085,
  U+2028 and U+2029 as line breaks, and the YAML library PermLang uses didn't,
  so text after one in a comment could be a key only GitHub read. A workflow or
  Action containing one is now unverifiable.
- **Secrets written other ways weren't recorded:** `SECRETS.NPM_TOKEN`,
  `secrets . KEY`, and `secrets[matrix.name]`, `toJSON(secrets)` and
  `secrets.*`, which record `ci.secret(all)`.
- **Workspace packages' install scripts** (npm, Yarn, Bun and pnpm workspaces)
  are recorded, not just the root `package.json`'s.
- **Local Actions and Docker images** are read and recorded; only an `@sha256:`
  digest counts as a pinned image.
- **Files PermLang can't read** are recorded with a hash, so editing them still
  changes the lock. A broken link no longer crashes the check, a byte-order mark
  is read normally, and only text inside `${{ }}` and `if:` counts as an
  expression.

### Fixed: AI tools, flow rules and specs

- **Tools from more frameworks are found:** OpenAI Agents, the OpenAI SDK
  (`runTools`, `zodFunction`), the MCP SDK's v2 server package, FastMCP,
  Genkit, LlamaIndex, LangChain, Mastra and Anthropic, plus plain tool objects
  in a `tools:` option in more forms, and provider tools. A collection of tools
  that can't all be listed gets a warning instead of passing silently. A
  library's prebuilt tool without a handler is unverifiable unless its
  framework's type says it runs at the model provider, and a hosted tool's
  callbacks are checked.
- **Tools that read any file, table or environment variable the model names**
  get a warning, like tools that send to any host.
- **A secret could leave without PERM009** through a function that returns it,
  through `exec`, through `eval`, or through code marked `@perm-unsafe`. All are
  caught.

### Changed

- **New options:** `check --base <ref>` (fail when a change stops using the
  base commit's lock) and `diff --summary <file>` (the uncut diff, for a job
  summary).
- **`init --workflow`** passes `--lock`, `--config`, `--adapter` and
  `--unmapped` into the workflow, installs dependencies where the nearest
  lockfile is, quotes names YAML would misread, and gives two folders that
  would share a workflow file separate ones.
- **Releases and CI** install dependencies without running their install
  scripts. The job that publishes to npm installs nothing, only commits on
  `main` are released, releases run one at a time, and `v0` only moves for the
  newest release.
- **The package** clears `dist/` before building and ships no source maps.
- **Docs:** every behavior above is documented in the
  [reference](docs/reference.md), and so is each remaining known limit,
  including how to protect the PermLang workflow itself (a required status
  check or a required workflow).

## 0.3.3 (2026-10-05)

Fixes to `permlang init`. If you generated a workflow for a **pnpm or Yarn**
project with `init --workflow`, run it again (after deleting the old workflow)
or copy the new install steps: the old ones stop working on 28 October 2026.

### Fixed

- **Generated pnpm and Yarn workflows break on Node 26.** They ran
  `corepack enable` with Node `lts/*`, which becomes Node 26 on 28 October, and
  Node 25 and later no longer include Corepack. The workflow now installs
  Corepack from npm first. Yarn 2 and later get `--immutable --mode=skip-build`,
  since they have no `--ignore-scripts`; Yarn 1 gets `--frozen-lockfile`.
- **The first pull request after `init --workflow` failed.** `init` wrote the
  lock before the workflow, so the lock didn't record the workflow's
  permissions. It now writes the workflow first.
- **`init` replaced an existing lock**, approving whatever had changed without
  showing it. It now keeps the lock, like the config, and says to run
  `permlang lock` and review the change.
- **The generated workflow in a monorepo package** went in the package's own
  `.github` folder, which GitHub ignores. It now goes in the repository's
  `.github/workflows`, named after the package, with `working-directory` set.
- **Paths in the generated workflow**: Windows-style paths are written with
  forward slashes, and a path with a space (which the Action can't pass) is
  refused with a suggestion, before anything is written.

### Changed

- The generated workflow also runs in merge queues, and on pushes to the
  repository's default branch instead of always `main`.

## 0.3.2 (2026-10-05)

### Fixed

- **A path above the working directory covered too much.** `fs.read(..)`
  covered `../../secrets`, and `fs.read(../..)` covered `../../../etc`: paths
  outside the folder it names. Now a path covers only itself and what's beneath
  it, as documented. In the other direction, `fs.read(..)` now also covers
  paths in the working directory, like `data/x`, which are beneath it too.
- Windows drive paths (`C:\data`) are treated as absolute, so `fs.read(.)` no
  longer covers them, and `..` can't climb above the drive.

### Added

- Property-based tests (`test/properties.test.ts`, using fast-check) for the
  rules that must hold for every input: escaping text into GitHub annotations,
  SARIF output, parsing `@perm`, path and host matching, reading and diffing
  the lock, and recording workflows and `package.json` scripts. They found the
  path bug above.
- Each GitHub release has the npm package attached, with a signed SLSA build
  provenance attestation for it, so anyone can check a package was built by
  this repository's release workflow: see
  [SECURITY.md](SECURITY.md#verifying-a-release).

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
