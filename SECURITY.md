# Security policy

PermLang is a security tool, so a way to get past it is a security bug.

## Supported versions

Fixes go into the latest release. Before 1.0, only the newest minor version is
supported.

| Version | Supported |
| --- | --- |
| 0.4.x | ✅ |
| 0.3.x and earlier | ❌ Upgrade to 0.4 |

**How long a version is supported.** Before 1.0, a minor version (0.4, say) gets
fixes, security fixes included, until the next minor version comes out; from
that day, only the new one does. Patch releases (0.4.1, 0.4.2) never make code
that passed fail, so upgrading within a minor version is always safe, and the
GitHub Action's `@v0` follows the newest 0.x release on its own. How long 1.0
and later versions are supported will be written here before 1.0 comes out.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:
go to the [Security tab](https://github.com/PermLang/PermLang/security), choose
**Report a vulnerability**, and describe what you found.

The most useful report includes a small code sample, the command you ran, what
PermLang reported, and what it should have reported.

We'll acknowledge your report within 7 days and keep you updated as we work on
a fix. Once a fix is released, we'll credit you in the release notes unless you'd
rather stay anonymous.

## What counts

- **A bypass:** code that reaches the network, files, a database, environment
  variables, or processes without PermLang reporting it, when it isn't one of the
  documented [known limits](docs/reference.md#known-limits). So is a pull request
  that adds access, or loosens the check, without the check failing or the
  comment showing it. This is the most important kind of report.
- **A problem in PermLang itself**, for example in the GitHub Action or the
  pull-request comment it posts.

A documented known limit is not a vulnerability, but ideas for closing one are
welcome as a regular issue. So are false positives, where PermLang reports access
that can't happen.

## How a report is handled

1. **Acknowledged** within 7 days.
2. **Confirmed and rated** within 14 days: we try to reproduce it, and rate its
   severity (critical, high, moderate, or low) by how easy it is to use and what
   it lets someone do. We tell you what we found.
3. **Fixed privately**, in a GitHub security advisory and its private fork, so
   the details stay private until the fix ships. The fork can't run CI, so the
   fix is tested in a temporary private repository, deleted after the release.
   We aim to release a fix within 30 days for a critical or high severity
   problem, and 90 for the rest, and tell you if it will take longer.
4. **Released and published together.** The fix ships as a patch release, and
   the advisory is published the same day, on
   [GitHub](https://github.com/PermLang/PermLang/security/advisories) (which
   adds it to GitHub's advisory database, so `npm audit` and Dependabot warn
   users of affected versions). It names the affected and fixed versions, what to
   do, and you, unless you'd rather stay anonymous. A problem that affects users
   gets a CVE.

Problems we find ourselves go through the same steps. Every advisory so far is
on [GitHub](https://github.com/PermLang/PermLang/security/advisories?state=published),
and the [threat model](docs/threat-model.md#vulnerabilities-found-and-fixed)
says how each was found.

## Vulnerabilities in PermLang's dependencies

The packages PermLang installs (listed in each release's
[SBOM](#whats-in-a-release-sbom)) are watched for known vulnerabilities, and
fixed on the schedule in [docs/policies.md](docs/policies.md#vulnerabilities-in-dependencies).

When a vulnerability in one of them can't affect PermLang (the vulnerable code
never runs in PermLang's use of the package, say), it's recorded in
[permlang.openvex.json](permlang.openvex.json): an
[OpenVEX](https://openvex.dev) document, which scanners can read, saying which
vulnerability, which versions of PermLang, and why it doesn't apply. The release
notes say so too. If a scanner reports one that isn't there, please open an issue.

## Verifying a release

Since 0.1.1, releases are built and published by the
[release workflow](.github/workflows/release.yml), never from a laptop (0.1.0,
the first, was published by hand to create the package). The job that
publishes installs nothing, so no dependency's code runs with the right to
publish. From 0.3.2, each package is signed with a SLSA build provenance
attestation, which says which repository, workflow, and commit built it.

To check a package from npm with the [GitHub CLI](https://cli.github.com):

```bash
npm pack permlang@0.4.1
gh attestation verify permlang-0.4.1.tgz --repo PermLang/PermLang
```

The same package is attached to each
[GitHub release](https://github.com/PermLang/PermLang/releases), with the
attestation as `.sigstore.json` (a Sigstore bundle, for
`gh attestation verify --bundle` or cosign) and `.intoto.jsonl` (the signed
provenance on its own). npm also records provenance for every version since
0.1.1, which `npm audit signatures` checks in your project.

### What's in a release (SBOM)

Releases after 0.4.1 also have a software bill of materials,
`permlang-<version>.cdx.json` (CycloneDX): every package that installing
PermLang installs, at the version PermLang was tested with, with its license
and checksum. It's signed as describing that release's package, which you can
check with:

```bash
gh attestation verify permlang-<version>.tgz --repo PermLang/PermLang --predicate-type https://cyclonedx.org/bom
```

### Rebuilding a release

The same source always builds the same package, byte for byte (CI checks this
on every pull request), so you can rebuild a release yourself and compare it
with npm's. With Node 24, as the release workflow uses:

```bash
git clone https://github.com/PermLang/PermLang && cd PermLang
git checkout v0.4.1
npm ci --ignore-scripts
npm run build
npm pack
npm view permlang@0.4.1 dist.shasum   # the same as: sha1sum permlang-0.4.1.tgz
```
