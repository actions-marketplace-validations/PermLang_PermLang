# PermLang specs (.perm files)

> **Phase 2 groundwork.** Today `permlang spec` checks a spec's **permissions**
> against the code that implements it. It parses and counts **rules** and
> **examples**, and reports them as not yet verified. It never reports them as
> passing.

A spec describes one piece of logic: what it must do, examples of it working, and
what it's allowed to touch. It's a plain text file, independent of the
implementation language, so the same format can cover code in other languages
later. A reviewer, or a manager, can read it without reading the code.

```
# refunds.perm
perm process_refund(order: Order, reason: Text) -> RefundResult
  implements: src/refunds.ts#processRefund

  must:
    refund only orders paid within the last 30 days
    never refund more than the amount paid
    refunds over $500 require manager approval

  examples:
    order(paid: $120, 5 days ago) -> refunded($120)
    order(paid: $120, 45 days ago) -> denied("outside 30-day window")

  perms:
    db.read(orders), db.write(refunds)
    payments.refund, email.send
```

## Format

- **`perm name(params) -> Result`** starts a spec, at the start of a line. The
  signature after the name is free text, for people. A file can hold any number
  of specs.
- **Sections** are indented under the header. Their content is indented further.
- **`implements: path#function`**: the code that implements the spec. The path is
  relative to the `.perm` file.
- **`must:`**: one rule per line, in plain language.
- **`examples:`**: one per line, as `input -> expected`.
- **`perms:`**: the capabilities the implementation may reach, in the same
  syntax as `@perm`. Commas separate entries, and entries can span lines.
  Required.
- **`#`** starts a comment line.

## Checking

```bash
npx permlang spec src              # every .perm file under the current directory
npx permlang spec src --spec refunds.perm
```

```
perm process_refund  src/refunds.ts#processRefund
  perms     no access beyond the declared scope
  must      3 rules, not verified yet (phase 2)
  examples  2 examples, not run yet (phase 2)
```

| Code | Meaning |
| --- | --- |
| SPEC001 | The spec file is invalid. |
| SPEC002 | The `implements:` function wasn't found among the checked files. |
| SPEC003 | The implementation reaches something `perms:` doesn't allow. The check fails. |
| SPEC004 | `perms:` allows something the implementation never uses (a warning, to keep specs minimal). |

The implementation's reach is computed exactly as for `permlang check`, through
helpers, adapters, and the whole call graph. A spec's `perms:` is a separate
declaration from any `@perm` on the function; both are checked.

## What comes next

These are the later phases planned for specs:

1. **Examples as tests.** Run each example against the implementation. That needs
   a precise mapping from example syntax to calls, which is still open.
2. **Rules.** Check `must:` rules with generated test cases, and prove the ones
   that can be proven.
3. **Generation.** Have AI write the implementation from the spec, and have the
   build verify it against rules, examples, and permissions.
4. **Other languages.** `implements:` names a file and a function, so adapters to
   analyzers for Go, Python, and Rust can check the same format.
