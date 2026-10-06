<div align="center">

# PermLang

**Know what your code can touch, before it ships.**

[![npm](https://img.shields.io/npm/v/permlang)](https://www.npmjs.com/package/permlang)
[![CI](https://github.com/PermLang/PermLang/actions/workflows/ci.yml/badge.svg)](https://github.com/PermLang/PermLang/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/PermLang/PermLang/graph/badge.svg)](https://codecov.io/gh/PermLang/PermLang)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-PermLang-2B3BFF?logo=github)](https://github.com/marketplace/actions/permlang)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/PermLang/PermLang/badge)](https://scorecard.dev/viewer/?uri=github.com/PermLang/PermLang)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15173/badge)](https://www.bestpractices.dev/projects/15173)
[![Permissions: checked by PermLang](https://img.shields.io/badge/permissions-checked%20by%20PermLang-2B3BFF)](https://github.com/PermLang/PermLang)

A safety check for TypeScript projects. It notices when a change makes your code
contact a new server, read or write files, use a secret, or change your database,
and makes sure someone sees it before it's merged.

[Get started](docs/getting-started.md) · [How it works](#how-it-works) · [Reference](docs/reference.md) · [Live demo](https://github.com/PermLang/permlang-demo/pull/1)

</div>

[![A pull request where the tests pass but PermLang fails: the change adds net(api.data-broker.io), reached from enrich and handleLead](https://raw.githubusercontent.com/PermLang/PermLang/main/docs/images/pr-check.png)](https://github.com/PermLang/permlang-demo/pull/1)

---

## Why it matters

Code gets written faster than ever, much of it by AI assistants. One added line
can send customer data to an unknown website, and in a pull request with hundreds
of changed lines, that line is easy to miss.

PermLang works like the permission prompts on your phone ("This app wants to use
your location"), but for your codebase. It keeps an inventory of what every part
of your code can reach. When a change reaches something new, PermLang flags it,
in plain view, on the pull request.

## How it works

| | Step | What happens |
| :---: | --- | --- |
| 1️⃣ | **Take inventory** | PermLang reads your code and records everything it can touch in a file called `permlang.lock.json`. You don't change any code to start. |
| 2️⃣ | **Check every change** | On each pull request, PermLang compares the new code to the inventory. |
| 3️⃣ | **Show what's new** | Anything new is posted as a comment on the pull request, and the check fails until someone approves it by updating the inventory. |

The image at the top is a real pull request: it adds an `enrich` helper that
sends each lead's email and phone number to `api.data-broker.io`. The tests still
pass. PermLang fails the check, marks the line, and comments with what's new.
In words: *this change makes the code send data to `api.data-broker.io` from
`enrich`, and `handleLead` can now trigger it too.*
[See the pull request](https://github.com/PermLang/permlang-demo/pull/1).

## What it watches

| | Kind of access | Example | Written as |
| :---: | --- | --- | --- |
| 🌐 | **The internet**: which servers the code contacts | Calling Stripe's API | `net(api.stripe.com)` |
| 📁 | **Files**: reading or writing them | Saving a report to disk | `fs.write(./reports)` |
| 🗄️ | **The database**: which tables are read or changed | Recording an order | `db.write(orders)` |
| 🔑 | **Secrets**: environment variables like API keys | Reading the Stripe key | `env(STRIPE_KEY)` |
| ⚙️ | **System commands**: running other programs | Starting a script | `exec` |
| 🧩 | **Your own actions**, defined per library | Issuing a refund | `payments.refund` |
| 🛠️ | **Your CI and scripts**: workflow permissions, secrets, Actions, install hooks | A workflow gaining write access | `ci.permission(contents: write)` |

It also flags two things code review rarely catches:

- **🤖 Tools you give an AI model.** A function registered as an AI tool (MCP,
  the Vercel AI SDK, OpenAI Agents, LangChain, LlamaIndex) can be triggered by
  whoever controls the model's input. PermLang lists every tool and what it can
  reach, and warns when a model could run commands, write data, send to any
  address, or read any file or secret it names.
- **🔒 Where secrets may go.** A rule like *"the Stripe key may only be sent to
  Stripe"* fails any change that lets the key reach another server.

## Going further: rules in the code

The inventory catches anything *new*. To also set limits, developers write a
one-line note above a function saying what it's allowed to do:

```ts
/** @perm net(api.stripe.com), db.write(orders), env(STRIPE_KEY) */
export async function chargeCustomer(order: Order) { ... }
```

If a later change makes that function do more, the build stops and says exactly
where, and how to fix it:

```
src/billing.ts:9:9 error PERM001: chargeCustomer calls fetch("https://data-broker.io/enrich", ...)
  but its declared permissions do not include net(data-broker.io).
  -> add net(data-broker.io) to @perm, or remove the call.
```

PermLang follows calls between functions and files, so moving the access into a
helper function doesn't get around it.

## Choose how strict

Start gentle and tighten up when you're ready.

| Level | Best for | What fails the build |
| --- | --- | --- |
| 🌱 **Sketch** | Trying it on an existing project | Only new access the inventory doesn't record, and rules you add to the settings file yourself (such as where a secret may go). Everything else is just reported. |
| 🛠️ **Development** (default) | Most teams | Also: functions that break their own rules, and public functions with no rules. |
| 🔒 **Production** | Sensitive code | Also: every function, including internal helpers, must be covered by a rule. |

## Get started

In a TypeScript project:

```bash
npm install --save-dev permlang
npx permlang init src --workflow
```

This creates the inventory, a settings file, and a GitHub workflow that checks
every pull request. Commit all three. The [getting started guide](docs/getting-started.md)
walks through the rest in about ten minutes.

> [!NOTE]
> **PermLang is new (v0.x).** Feedback, false positives, and missed access are
> all welcome as [issues](https://github.com/PermLang/PermLang/issues). See the
> [changelog](CHANGELOG.md) for what each release changes.

## What it can't see (yet)

PermLang is upfront about its blind spots, and reports them instead of hiding them:

- **Libraries it doesn't know.** It understands many popular ones (Stripe, AI
  SDKs, Redis, databases, HTTP clients, and more). Unknown libraries are listed
  in every report, so you can decide whether to trust them.
- **Code that can't be analyzed ahead of time**, such as `eval`, is an error
  unless a developer marks it as reviewed and gives a reason. Every such
  exception is listed.
- A few advanced tricks are documented, with tests, in the
  [reference](docs/reference.md#known-limits).

## Common questions

**Does it work with code from AI coding assistants?**
Yes. It checks the code, whoever wrote it: GitHub Copilot, Cursor, another AI
assistant, or a person. It's built for the pull request nobody reads line by line.

**How do I see what my MCP server's tools can do?**
Run `npx permlang check src`. The report lists every tool registered with MCP,
the Vercel AI SDK, OpenAI Agents, LangChain, or LlamaIndex, what each can reach,
and warns when a model could use one to run commands, write data, send to any
address, or read any file or secret it names.
[More on AI tools](docs/reference.md#tools-given-to-ai-models).

**How is it different from CodeQL or Semgrep?**
Those scanners look for known-bad patterns, such as SQL injection. PermLang
tracks what your code can reach and flags anything new, even when it looks
perfectly normal, like a call to an unfamiliar server. They work well together:
PermLang's own repository runs CodeQL too.

**Does it run my code or send it anywhere?**
No. It reads your source with the TypeScript compiler and never runs it. Your
code stays on your machine or CI runner: the command-line tool makes no network
calls, and the GitHub Action only posts its results to the pull request.

**Is it free?**
Yes. PermLang is open source under the Apache 2.0 license.

## Learn more

| | |
| --- | --- |
| 📘 [Getting started](docs/getting-started.md) | From zero to a pull-request check in ten minutes |
| 📖 [Reference](docs/reference.md) | Everything it detects, matching rules, libraries, the lock file, the GitHub Action, and the command line |
| 🧪 [Real-world trial](docs/trial-2026-09.md) | Results on two open-source apps, Umami and Ghostfolio |
| 📝 [Spec format](docs/spec-format.md) | Early work on describing business rules alongside permissions |
| 🗒️ [Changelog](CHANGELOG.md) | What changed, release by release |

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license covers
the code; it grants no rights to the PermLang name or marks (Section 6).
