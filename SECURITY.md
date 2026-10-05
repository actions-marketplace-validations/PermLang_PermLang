# Security policy

PermLang is a security tool, so a way to get past it is a security bug.

## Supported versions

Fixes go into the latest release. Before 1.0, only the newest minor version is
supported.

| Version | Supported |
| --- | --- |
| 0.3.x | ✅ |
| 0.2.x and earlier | ❌ Upgrade to 0.3 |

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:
go to the [Security tab](https://github.com/PermLang/permlang/security), choose
**Report a vulnerability**, and describe what you found.

The most useful report includes a small code sample, the command you ran, what
PermLang reported, and what it should have reported.

We'll acknowledge your report within 7 days and keep you updated as we work on
a fix. Once a fix is released, we'll credit you in the release notes unless you'd
rather stay anonymous.

## What counts

- **A bypass:** code that reaches the network, files, a database, environment
  variables, or processes without PermLang reporting it, when it isn't one of the
  documented [known limits](docs/reference.md#known-limits). This is the most
  important kind of report.
- **A problem in PermLang itself**, for example in the GitHub Action or the
  pull-request comment it posts.

A documented known limit is not a vulnerability, but ideas for closing one are
welcome as a regular issue. So are false positives, where PermLang reports access
that can't happen.
