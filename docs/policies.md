# Project policies

How PermLang chooses and tracks its dependencies, which findings stop a change
from merging, how secrets are kept, and what every change must include. Each
rule says what enforces it.

- [Dependencies](#dependencies)
- [Vulnerabilities in dependencies](#vulnerabilities-in-dependencies)
- [Static analysis](#static-analysis)
- [Secrets and credentials](#secrets-and-credentials)
- [Tests](#tests)
- [Code](#code)

## Dependencies

### Choosing one

Installing PermLang installs two packages and what they need:
[ts-morph](https://ts-morph.com) (to read TypeScript) and
[yaml](https://eemeli.org/yaml/) (to read workflows). A new dependency that
ships with PermLang needs a reason in its pull request, and must:

- be maintained, and used widely enough that problems get found;
- have a license on the [list below](#licenses);
- work without its install scripts, which PermLang's CI and releases never run;
- come with TypeScript types.

Development tools (for tests, linting and types) don't ship, but follow the
same license rule.

### Getting and tracking them

- `npm ci` installs exactly the versions `package-lock.json` pins, and checks
  each package's checksum. CI and releases also pass `--ignore-scripts`.
- GitHub Actions are pinned to a full commit hash, with the version in a
  comment beside it.
- [Dependabot](../.github/dependabot.yml) proposes updates every week: minor and
  patch updates grouped, major ones on their own.
- Each release comes with an SBOM, a list of every package installing PermLang
  installs, at the version it was tested with
  ([SECURITY.md](../SECURITY.md#whats-in-a-release-sbom)).

### Licenses

A dependency must allow PermLang to be distributed under Apache 2.0. The
[dependency review](../.github/workflows/dependency-review.yml) fails a pull
request that adds or updates a package under any other license. The allowed
licenses are 0BSD, Apache-2.0, BlueOak-1.0.0, BSD-2-Clause, BSD-3-Clause,
CC0-1.0, CC-BY-4.0, ISC, MIT, MIT-0, MPL-2.0, Python-2.0 and Unlicense.
MPL-2.0 is there for lightningcss, which only the test runner uses; a shipped
dependency under it would need a maintainer's decision. So would any license
not on the list, recorded in the pull request that adds it to the workflow.

## Vulnerabilities in dependencies

Three things look for them: the dependency review on every pull request,
GitHub's Dependabot alerts (and the security updates Dependabot proposes) for
what's already in use, and [OpenSSF Scorecard](https://scorecard.dev) every
week.

- **A pull request can't add or update a dependency with a known
  vulnerability**, of any severity. The dependency review fails it.
- **A vulnerability in a dependency already in use** is fixed, by updating or
  replacing the package, within 7 days for critical and high severity, and
  within 30 days for moderate and low, from when the alert appears.
- **No release ships** with an open alert for a package in its SBOM, unless the
  vulnerability has been shown not to affect PermLang (below).
- **A vulnerability that can't affect PermLang**, because the code it's in
  never runs in PermLang's use of the package, for example, can be let through,
  but only with the reason written down: as a comment beside its advisory ID in
  the dependency review's `allow-ghsas`, or as the reason for dismissing the
  Dependabot alert. For a package that ships, the release notes say so too.

## Static analysis

These run on every pull request:

- **CodeQL**, GitHub's code scanning, reads PermLang's TypeScript and its
  workflows for security problems. It also runs every week.
- **ESLint**, with typescript-eslint's rules that read types
  ([eslint.config.js](../eslint.config.js)).
- **TypeScript**, in strict mode.

What they find:

- **Any ESLint or TypeScript error** stops the pull request from merging.
- **A CodeQL alert of high or critical severity** stops it too, until it's
  fixed or dismissed as a false positive, with the reason written in the
  dismissal.
- **Medium and low CodeQL alerts** are fixed, or dismissed with a reason,
  before the next release.
- **Scorecard's findings** are looked at before each release, and a drop in its
  score is explained or fixed.

## Secrets and credentials

- **No secret is stored** in the repository or in GitHub's Actions secrets.
  Publishing to npm uses npm's trusted publishing, and uploading coverage uses
  Codecov's: both use a short-lived token GitHub issues to that one run
  (OIDC).
- **Each workflow job gets only the permissions it needs**, and none gets write
  access by default.
- **GitHub's secret scanning and push protection are on**, so a commit with a
  known kind of credential in it is blocked before it's pushed.
- **Maintainers use two-factor authentication** on GitHub and on npm.
- **If a credential leaks**, it's revoked straight away. Then a maintainer
  checks what it could reach and whether it was used, and publishes a security
  advisory if users could be affected.

PermLang's Action uses only the token of the job it runs in, or one you pass it,
and never prints it.

## Tests

- **Every change comes with a test that proves it**, which fails without the
  change ([CONTRIBUTING.md](../CONTRIBUTING.md#making-a-change)).
- **A new detection rule is broken on purpose** before it merges, to make sure a
  test notices.
- **Ways to hide access** go in the adversarial suite, and rules that must hold
  for every input are property tests, which try hundreds of generated inputs.
- **CI runs every test** on Linux with Node 20, 22, 24 and 26, and on Windows
  with Node 24, for every pull request and every push to `main`. A pull request
  can't merge until they pass.
- **Coverage is measured** on every pull request, and new code should be at
  least 90% covered.
- **PermLang checks its own code** on every pull request, twice: with the
  pull request's version and with the last release.

## Code

- TypeScript in strict mode, which also treats every read from an array or a
  record as possibly missing (`noUncheckedIndexedAccess`).
- ESLint's and typescript-eslint's recommended rules, including those that read
  types. A rule is switched off for a line only with the reason beside it.
- Each source file starts with its SPDX license and copyright lines, and no
  file contains invisible characters or ones that change the direction text is
  shown in ([test/source-files.test.ts](../test/source-files.test.ts)).
- The same source always builds the same package, byte for byte, which CI
  checks on every pull request.
