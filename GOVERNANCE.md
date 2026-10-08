# Governance

How PermLang is run: who decides, who can do what, and how that changes.

## Roles

- **Contributors** are anyone who opens an issue, a discussion, or a pull
  request. Every commit in a pull request is signed off
  ([CONTRIBUTING.md](CONTRIBUTING.md#signing-off)), and every pull request passes
  the same checks.
- **Maintainers** review and merge pull requests, make releases, answer security
  reports, and hold the project's accounts. [MAINTAINERS.md](MAINTAINERS.md)
  lists who they are and what each can reach.

PermLang has one maintainer today. Finding a second, so that every change is
reviewed by someone other than its author and the project doesn't depend on one
person, is on the [roadmap](ROADMAP.md).

## How decisions are made

Changes are proposed and discussed in the open: in an
[issue](https://github.com/PermLang/PermLang/issues), a
[discussion](https://github.com/PermLang/PermLang/discussions), or a pull
request. The maintainers decide, aiming for agreement, and say why in the issue
or pull request when they turn something down. With more than one maintainer,
a change they disagree on waits until they agree, or until the one who opened
it withdraws it.

Security reports are the exception: they're discussed privately until a fix is
released ([SECURITY.md](SECURITY.md)).

## Changes to the code

Every change to `main` is a pull request, and can't merge until every required
check passes: the tests on Linux and Windows, the type check and linter,
PermLang's checks of its own code, the SBOM and reproducible-build checks,
dependency review, CodeQL, and sign-off. These rules apply to administrators
too, and `main` can't be force-pushed or deleted.

While there's one maintainer, the maintainer reviews every pull request before
merging it. Once there are two, every pull request will
need approval from a maintainer who isn't its author, and branch protection will
require it.

A fix for an undisclosed vulnerability is the one exception. It's made in a
private fork attached to its security advisory, where CI can't run, so it's
tested in a temporary private repository instead, deleted after the release.
It's merged from the advisory just before the release that ships it: the
required checks can't report from the private fork, so a maintainer lets
administrators bypass them for that merge only, and turns the rule back on
straight after ([SECURITY.md](SECURITY.md)).

## Getting more access

Access is given only as far as it's needed, and reviewed before it's given:

1. **Triage** (labelling and closing issues) goes to a contributor whose work
   the maintainers know, when they ask for it.
2. **Write access, and becoming a maintainer,** goes to a contributor with a
   record of sound, reviewed pull requests, when the existing maintainers agree.
   Before it's given, the maintainers review the person's contributions and
   their account, which must use two-factor authentication.
3. **Administrator access, npm publishing, and the other accounts** in
   [MAINTAINERS.md](MAINTAINERS.md) go only to maintainers, and only as needed.

The maintainers review who has access every six months, and when someone stops
contributing. Access that isn't needed any more is removed, and
[MAINTAINERS.md](MAINTAINERS.md) is updated in the same pull request.

## If a maintainer leaves

A maintainer who wants to step down says so in a pull request that updates
[MAINTAINERS.md](MAINTAINERS.md), and hands over the accounts they hold. If the
last maintainer becomes unable to continue, the project's GitHub organization,
npm package, and other accounts pass to whoever they've named for that in
[MAINTAINERS.md](MAINTAINERS.md). Until a second maintainer is named, there's no
such person, which the [roadmap](ROADMAP.md) addresses.

## Repositories

PermLang's code lives in these repositories in the
[PermLang organization](https://github.com/PermLang):

| Repository | What it is | Released? |
| --- | --- | --- |
| [PermLang/PermLang](https://github.com/PermLang/PermLang) | PermLang itself: the command-line tool, the npm package, and the GitHub Action | Yes: every release comes from here |
| [PermLang/permlang-demo](https://github.com/PermLang/permlang-demo) | An example project that shows PermLang's pull-request check | No |
| [PermLang/.github](https://github.com/PermLang/.github) | The organization's profile page | No |

Only PermLang/PermLang is released, so its security requirements cover
everything PermLang ships. The other two hold no code that runs anywhere but
their own workflows.

## Changing this document

Changes to how PermLang is governed are made the same way as code: in a pull
request, which the maintainers review.
