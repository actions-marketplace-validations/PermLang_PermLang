# Contributing to PermLang

Thanks for helping. PermLang is a security tool, so the bar is simple: every
change comes with a test that proves it.

## Reporting

- **A way to get past PermLang** (code that reaches the network, files, secrets,
  a database, or processes without being reported, or a pull request that adds
  access without the check failing): please report it **privately**, as
  [SECURITY.md](SECURITY.md) describes, not in a public issue.
- **A false positive, a missed access that's already a documented limit, or a
  bug:** open an [issue](https://github.com/PermLang/PermLang/issues/new/choose).
  There's a form for each.
- **Questions and ideas:** [Discussions](https://github.com/PermLang/PermLang/discussions).

We aim to reply to every issue and pull request within a week.

## Setting up

To run the tests, use Node 22.12 or later, which is what Vitest supports.
(PermLang itself runs on Node 20.1 or later, and CI tests it there too.)

```bash
git clone https://github.com/PermLang/PermLang && cd PermLang
npm install
npm test                                          # all tests
npm run test:coverage                             # ...and what they cover
npm run typecheck                                 # TypeScript, strict
npm run permlang -- check src                     # PermLang checks its own code
```

[docs/reference.md](docs/reference.md#development) describes how the code is
organized.

## Making a change

1. **Write the test first.** Each detection rule has fixtures under
   `fixtures/`: files in `pass/` must produce no diagnostics, and files in
   `fail/` must produce exactly the ones they mark:

   ```ts
   writeFileSync("./data/out.json", data); // expect: error PERM001 fs.write(./data/out.json)
   ```

   Ways to hide access belong in the adversarial suite
   (`test/adversarial.test.ts`): `caught` for what must be reported, `silent`
   for harmless code that mustn't be, and `knownMisses` for documented gaps.
   Each known miss's test fails once it's fixed.

   Rules that must hold for every input, such as escaping, path matching, and
   reading the lock, are property tests in `test/properties.test.ts`:
   [fast-check](https://fast-check.dev) generates hundreds of inputs and
   shrinks a failure to the smallest one. When one fails, it prints a seed and
   the input, which make good example tests.
2. **Make the change.** Keep modules small, and match the style around you.
   TypeScript runs in strict mode, and warnings must be fixed, not suppressed.
3. **Check that the test fails without your change.** For a fix, the new test
   should fail on `main`. We break each new rule on purpose before merging, to
   make sure a test notices.
4. **Run everything:** `npm run typecheck && npm test`, then
   `npm run permlang -- check src`. If PermLang's check on itself reports new
   access, that's expected when the change adds some: declare it in `@perm`,
   then run `npm run permlang -- lock src` and commit `permlang.lock.json`.
   PermLang's code is also checked by its last release, against a lock of its
   own (see below): run
   `npm run permlang:released -- lock src --lock permlang.released.lock.json`
   too, and commit `permlang.released.lock.json`.
5. **Update the docs and [CHANGELOG.md](CHANGELOG.md)** when behaviour changes,
   including any new known limit.
6. **Open a pull request.** Every check must pass before it can merge.

PermLang checks its own pull requests twice
([`.github/workflows/permlang.yml`](.github/workflows/permlang.yml)):

- with the pull request's own copy of the Action (`uses: ./`), so a change to
  PermLang is tried on PermLang itself, against `permlang.lock.json`;
- with the last release, pinned to its commit, against
  `permlang.released.lock.json`, which that release wrote. A pull request can't
  change the code that runs this check, so it can't change how its own new
  access is judged. A change to what PermLang detects changes what the new
  version sees in this code, but not what the release sees, so this lock only
  changes when PermLang's own code does.

`npm run permlang:released` runs that release, whichever version the workflow
pins. When Dependabot moves the pin to a new release, relock with it in the same
pull request.

## Versions

Before 1.0, a change that can make previously passing code fail (detecting
something new, for instance) is a minor version; anything else is a patch.
[docs/releasing.md](docs/releasing.md) has the details.

## License

PermLang is licensed under [Apache 2.0](LICENSE). By contributing, you agree
that your contribution is licensed under it too.
