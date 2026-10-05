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

This writes three files. Commit all of them:

| File | What it is |
| --- | --- |
| `permlang.config.json` | Settings. Starts at `"strictness": "sketch"`: everything is reported, and only new access the lock doesn't record fails. |
| `permlang.lock.json` | What every function can reach today (network hosts, files, database tables, environment variables, processes), and what your workflows and `package.json` scripts grant (token permissions, secrets, Actions, install hooks). |
| `.github/workflows/permlang.yml` | Installs your dependencies (for their types), then runs PermLang on every pull request and comments the permission diff. |

## 3. Review what you have

```bash
npx permlang check src
```

Look at four things:

- **Packages with no adapter.** PermLang can't see what these touch, so it
  trusts them. Each gets one warning (PERM006). For each one, either add an
  adapter (see [Adapter manifests](reference.md#adapter-manifests)) or declare it pure. A small
  team adapter file, listed under `"adapters"` in `permlang.config.json`, does
  either.
- **Unverifiable code** (PERM004): `eval`, `new Function`, computed calls on
  `fs` or `globalThis`, `require` of a computed path. Rewrite it, or mark the
  function `@perm-unsafe reason:"..."`. Every override is listed in every report.
- **Tools an AI model can call** (if you use MCP, the Vercel AI SDK, OpenAI
  Agents, or LangChain). The report lists each tool and what it can reach. A
  tool that can run commands, write data, or send to any address gets a warning
  (PERM008): whoever controls the model's input can trigger it. Narrow what the
  tool can do, or have a person confirm before it runs.
- **The lock file.** It's the inventory of what your code can touch, and what
  your CI and scripts grant. Anything surprising in it is worth a look now.

## 4. Work with the lock

From now on, when a change gives code new access, `permlang check` fails:

```
src/leads.ts:8:1 error PERM005: handleLead can now reach net(api.data-broker.io), which permlang.lock.json doesn't record.
  -> run `permlang lock` and commit the change so reviewers see it.
```

If the access is intended, run `npx permlang lock` and commit the lock change.
Reviewers see it in the pull request, and the Action's comment shows where the
new access happens and which functions can now reach it. Until the lock change is
committed, the comment is marked **Not approved yet**, matching the failing check:

```bash
npx permlang diff origin/main
```

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

Then raise `"strictness"` in `permlang.config.json`:

- `development`: annotated functions can't exceed their `@perm`, and exported
  functions must declare what they reach.
- `production`: every function must be covered, private helpers included.

Set `"unmapped": "error"` to require every package to be mapped or declared pure,
and `"tools": "error"` to fail the build on risky AI tools.

To say where a secret may go, add a flow rule. This fails any change that lets
the Stripe key reach a server other than Stripe's:

```json
{ "flows": [{ "from": "env(STRIPE_KEY)", "to": ["net(api.stripe.com)"] }] }
```

Every setting is listed in the [reference](reference.md#configuration).

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
