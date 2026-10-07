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
  relative to the `.perm` file. A method is `Class.method`. When the name matches
  more than one function in the file (`build` in two namespaces, say), the check
  fails until you write the qualified name, with the namespaces and functions it's
  declared in: `src/reports.ts#Reports.build`. A name that is one function's whole
  qualified name means that function: `#make` is a top-level `make`, even when
  another function declares a `make` of its own (that one is `#outer.make`). A
  getter and a setter of the same property are checked together.
- **`must:`**: one rule per line, in plain language.
- **`examples:`**: one per line, as `input -> expected`.
- **`perms:`**: the capabilities the implementation may reach, in the same
  syntax as `@perm`. Commas separate entries, and entries can span lines.
  Required.
- **`#`** starts a comment line.

Files are UTF-8, and may start with a byte-order mark.

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

1 spec, 0 failing.
```

| Code | Meaning |
| --- | --- |
| SPEC001 | The spec file is invalid. `permlang spec` then exits 2, like any other error in what it was given; 1 means permission errors only. |
| SPEC002 | The `implements:` function wasn't found among the checked files, or its name matches more than one function. |
| SPEC003 | The implementation reaches something `perms:` doesn't allow. The check fails. |
| SPEC004 | `perms:` allows something the implementation never uses (a warning, to keep specs minimal). |
| SPEC005 | The implementation reaches code PermLang can't see, so its permissions can't be checked. The check fails. |

The implementation's reach is computed exactly as for `permlang check`, through
helpers, adapters, and the whole call graph. A spec's `perms:` is a separate
declaration from any `@perm` on the function; both are checked.

A spec never passes on code PermLang can't see. If the implementation, or
anything it calls, uses an import whose types can't be found or a name with no
declaration (Node's `child_process` or `process` without `@types/node`, say), or
calls something typed `any` (a package export declared `any`, a member of an
`any` index, `JSON.parse(text).send()`), its access is invisible, so the spec is
**unchecked** (`SPEC005`) and the check fails:

```
perm process_refund  src/refunds.ts#processRefund
  perms     unchecked: reaches code PermLang can't see
  ...
  refunds.perm:3 error SPEC005: perm process_refund: processRefund reaches code PermLang can't see, so its permissions can't be checked: it calls into node:child_process, whose types can't be found.
    -> install the missing types (@types/node for Node's modules and globals, such as process), then run it again.

1 spec, 1 failing.
```

The fix says what to do: install the missing types, or give what's called a type
other than `any`. An `any` value that the implementation passes somewhere else to
be called (a callback typed `any`) isn't noticed.

Unused permissions aren't reported for an unchecked spec, since the code that
can't be seen may use them. Calls into packages with no adapter are trusted
here; `permlang check` lists them, and its lock file records them.

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
