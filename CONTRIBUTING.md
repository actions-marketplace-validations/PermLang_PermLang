# Contributing to PermLang

Thanks for helping. PermLang is a security tool, so the bar is simple: every
change comes with a test that proves it.

## Reporting

- **A way to get past PermLang** (code that reaches the network, files, secrets,
  a database, or processes without being reported): please report it
  **privately**, as [SECURITY.md](SECURITY.md) describes, not in a public issue.
- **A false positive, a missed access that's already a documented limit, or a
  bug:** open an [issue](https://github.com/PermLang/PermLang/issues/new/choose).
  There's a form for each.
- **Questions and ideas:** [Discussions](https://github.com/PermLang/PermLang/discussions).

We aim to reply to every issue and pull request within a week.

## Setting up

You need Node 22 or later to run the tests. (PermLang itself runs on Node 20.1
or later.)

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
5. **Update the docs and [CHANGELOG.md](CHANGELOG.md)** when behaviour changes,
   including any new known limit.
6. **Open a pull request.** Every check must pass before it can merge.

## Versions

Before 1.0, a change that can make previously passing code fail (detecting
something new, for instance) is a minor version; anything else is a patch.
[docs/releasing.md](docs/releasing.md) has the details.

## License

PermLang is licensed under [Apache 2.0](LICENSE). By contributing, you agree
that your contribution is licensed under it too.
