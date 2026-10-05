# Releasing PermLang

The npm package is `permlang`, owned by the npm user `parkweb`, with the
`@permlang` scope reserved by the `permlang` org.

## Making a release

1. Merge a PR that bumps `version` in `package.json` (and `package-lock.json`)
   and dates the `CHANGELOG.md` section, **once all its checks have passed**.
   The release runs the same tests and stops before publishing if they fail.
2. On GitHub, create a release with the tag `v<version>`, including the `v`
   (for example `v0.2.3`), on `main`.

The [release workflow](../.github/workflows/release.yml) runs in two jobs:

1. **Build**, with read-only access: checks that the tag matches
   `package.json` and that the release commit is on `main`, installs the
   dependencies, runs the tests, and packs the package.
2. **Publish**, which installs nothing, so no dependency's code ever runs with
   the right to publish: signs a build provenance attestation for that tarball,
   publishes the same tarball to npm with provenance, attaches it and the
   attestation to the GitHub release, and moves the `v0` tag.

Releases run one at a time. Re-running a release is safe: a version already on
npm is skipped, and `v0` only moves for the newest release, so re-running an
older one can't move it back. A pre-release (a version such as `0.4.0-rc.1`,
with the release marked as a pre-release on GitHub) is published under npm's
`next` tag and leaves `v0` alone. A new version can take a few minutes to
download from npm after the workflow finishes.

The attached files are what OpenSSF Scorecard's Signed-Releases check looks
for, so don't remove them from a release.
[SECURITY.md](../SECURITY.md#verifying-a-release) tells users how to verify
them.

## Choosing the version

Before 1.0, the minor version marks changes that can fail builds that passed
before:

- **Patch** (`0.2.0` → `0.2.1`): fixes and new detection that don't make
  previously passing code fail, plus docs.
- **Minor** (`0.2.x` → `0.3.0`): anything that can make previously passing code
  fail, such as detecting a new kind of access. Say so at the top of the
  changelog section.

npm users on `^0.2.0` only get patches. Action users on `@v0` get every 0.x
release, minors included, because the workflow moves `v0` each time. The
reference tells users to pin an exact release if they don't want that.

## One-time setup (done for 0.1.0, 2026-10-01)

npm's trusted publishing can only be set up on a package that already exists,
so 0.1.0 was published by hand (`npm login`, then `npm publish --access public`
from a clean `main`). The package's npm settings then got a Trusted Publisher:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `PermLang` |
| Repository | `PermLang` |
| Workflow filename | `release.yml` |
| Environment | *(empty)* |
| Allowed actions | **Allow `npm publish`** ticked |

Without **Allow `npm publish`**, npm only lets the workflow stage a release, and
publishing fails with `OIDC permission denied for this action`.

The repository name must match GitHub's exactly, capitals included: npm compares
the name GitHub reports when the workflow signs in. When the repository was
renamed from `permlang` to `PermLang` (2026-10-02), publishing failed with
`404 Not Found - PUT https://registry.npmjs.org/permlang` until the connection
was recreated. If the repository is renamed again, recreate the connection
(npm doesn't let you edit it) before the next release.

**Publishing access** is set to "Require two-factor authentication and disallow
tokens", so only the workflow, or a person with 2FA, can publish.
