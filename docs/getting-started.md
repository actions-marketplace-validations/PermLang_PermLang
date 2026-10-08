# Getting started with PermLang

This takes an existing TypeScript project from nothing to a pull-request check
that shows new access, in about ten minutes. You don't need to annotate
anything to start.

## 1. Install

```bash
npm install --save-dev permlang
```

PermLang reads your code through the TypeScript compiler. It needs the same
types your build uses:

- **`@types/node`**, or Node built-ins like `fs` and `child_process` are
  invisible. PermLang reports any import whose types it can't find (PERM007).
- **A generated Prisma client**, if you use Prisma: run `prisma generate` first,
  or database access is invisible.
- **Real types for your dependencies.** A shim like `declare module "jsonwebtoken";`
  types everything from that package `any`, so its calls are invisible too.
  PermLang reports each one (PERM007); installing the package's types fixes it.

## 2. Set up

```bash
npx permlang init src --workflow
```

Use `--project tsconfig.json` instead of `src` to check a TypeScript project's files.
In a monorepo, run it in the package you want checked.

This writes three files. Commit all of them:

| File | What it is |
| --- | --- |
| `permlang.config.json` | Settings. Starts at `"strictness": "sketch"`: everything is reported, and only a difference between the code and the lock fails, such as new access the lock doesn't record (plus any flow rules, or `"error"` policies, you add later). |
| `permlang.lock.json` | What every function can reach today (network hosts, files, database tables, environment variables, processes), and what your workflows and `package.json` scripts grant (token permissions, secrets, Actions, install hooks). It also records which files were checked (`src` here, and any files it imports from elsewhere), the settings, and the code PermLang can't check (packages with no adapter, imports with no types). |
| `.github/workflows/permlang.yml` | On every pull request, installs your dependencies (for their types) in one job, then runs PermLang in another, where nothing from the pull request runs, and comments the permission diff. ([Why two jobs](reference.md#github-action).) |

## 3. Review what you have

```bash
npx permlang check src
```

At sketch, each exported function without a `@perm` annotation gets a warning
(PERM003). Those can wait until step 5. Look at four things:

- **Packages with no adapter.** PermLang can't see what these touch, so it
  trusts them. Each gets one warning (PERM006). For each one, either add an
  adapter (see [Adapter manifests](reference.md#adapter-manifests)) or declare it pure. A small
  team adapter file, listed under `"adapters"` in `permlang.config.json`, does
  either. The lock records them, so a pull request that starts using a new one
  fails until it's reviewed and `permlang lock` records it.
- **Unverifiable code** (PERM004): `eval`, `new Function`, computed calls on
  `fs` or `globalThis`, `require` of a computed path or of `child_process`,
  `data:` imports, calls into your own JavaScript through a hand-written `.d.ts`.
  It's reported on the exported function that reaches it, and the lock records
  every use. Rewrite it, or mark the function `@perm-unsafe reason:"..."`. Every
  override is listed in every report.
- **Tools an AI model can call** (if you use MCP, the Vercel AI SDK, the OpenAI
  SDK, OpenAI Agents, LangChain, LlamaIndex, Genkit, or another framework
  [it recognizes](reference.md#tools-given-to-ai-models)). The report lists each
  tool and what it can reach. A tool that can run commands, write data, send to
  any address, or read whatever file, table, or secret the model names gets a
  warning (PERM008): whoever controls the model's input can trigger it. Narrow
  what the tool can do, or have a person confirm before it runs.
- **The lock file.** It's the inventory of what your code can touch, and what
  your CI and scripts grant. Anything surprising in it is worth a look now.

## 4. Work with the lock

From now on, when a change gives code new access, `permlang check` fails. Here,
a new `enrich` helper sends leads to a data broker, and `handleLead` calls it:

```
src/leads.ts:21:21 error PERM005: enrich can now reach net(api.data-broker.io), which permlang.lock.json doesn't record.
  -> run `permlang lock` and commit the change so reviewers see it.

src/leads.ts:30:16 error PERM005: handleLead can now reach net(api.data-broker.io), which permlang.lock.json doesn't record.
  -> run `permlang lock` and commit the change so reviewers see it.
```

If the access is intended, run `npx permlang lock src` and commit the lock change.
Reviewers see it in the pull request, and the Action's comment shows where the
new access happens and which functions can now reach it. Until the lock change is
committed, the comment is marked **Not approved yet**, matching the failing check.
To see the same diff on your machine:

```bash
npx permlang diff origin/main src
```

The lock has to match the code exactly, so the check also fails when the lock
records access the code no longer reaches (otherwise a change could approve
access in advance by editing only the lock), when a `@perm-unsafe` override is
added, removed, or reworded, and when code starts or stops using a package with
no adapter. In the GitHub Action, it also fails when a pull request deletes the
lock file. `permlang lock` fixes each of these, and the lock's diff shows what
changed.

Run `permlang check` and `permlang lock` with the same paths and options as your
workflow (`src` here): the lock records them, and a check of other files, or with
other settings, fails with one error that says what differs.

Make the PermLang check a **required status check** in your branch protection
rules or ruleset. A pull request runs its own version of the workflow, so without
that, one that removes the PermLang step could still be merged. The
[reference](reference.md#github-action) has more on protecting the workflow.

## 5. Enforce, when you're ready

Annotations make the rules explicit. Add `@perm` to the functions that matter,
starting with entry points like route handlers, jobs, and public APIs:

```ts
/** @perm net(api.stripe.com), db.write(payment), env(STRIPE_KEY) */
export async function charge(order: Order) { ... }
```

A whole file can share one declaration:

```ts
/**
 * @module
 * @perm net(api.stripe.com)
 */
```

(or, on one line, `/** @module @perm net(api.stripe.com) */`).

Then raise `"strictness"` in `permlang.config.json`:

- `development`: annotated functions can't exceed their `@perm`, and exported
  functions and entry points (route tables, plugin hooks, tool definitions) must
  declare what they reach.
- `production`: every function must be covered, private helpers included.

Set `"unmapped": "error"` to require every package to be mapped or declared pure,
and `"tools": "error"` to fail the build on risky AI tools.

To say where a secret may go, add a flow rule. This fails a change where a
function that gets hold of the Stripe key can also send to a server other than
Stripe's, send an email (or take another action an adapter defines), run a
command, or call code PermLang can't see:

```json
{ "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }] }
```

It works from the functions that read the key, not the key itself: a key read into
a constant outside any function, and used elsewhere, isn't followed. Read it inside
the function that uses it. [Data-flow rules](reference.md#data-flow-rules) has the
details and the other limits.

Settings are recorded in the lock, so loosening one shows up in review like new
access does. After changing `permlang.config.json`, run `npx permlang lock src`
and commit both files; the pull request's comment lists the change under
**Check settings changed**. Every setting is listed in the
[reference](reference.md#configuration).

## 6. Show it (optional)

Let visitors know your project's permissions are checked. Add this badge to your
README:

[![Permissions: checked by PermLang](https://img.shields.io/badge/permissions-checked%20by%20PermLang-2B3BFF)](https://github.com/PermLang/PermLang)

```markdown
[![Permissions: checked by PermLang](https://img.shields.io/badge/permissions-checked%20by%20PermLang-2B3BFF)](https://github.com/PermLang/PermLang)
```

## Reference

- Capabilities and matching rules, adapters, and known limits: [Reference](reference.md)
- What PermLang found on real projects: [trial report](trial-2026-09.md)
