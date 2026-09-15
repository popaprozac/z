# Pattern binding with `else` — design handoff

Status: direction agreed in a side conversation on 2026-09-10. **Not implemented.**
This records the decision for the main conversation to resume later; it does not
change the current native-subclass/Zapp work sequence. Detailed grammar, ownership
spelling, and first implementation scope still need review before implementation.

## Agreed direction

Prefer a refutable pattern binding with an explicit, non-fallthrough `else` over
adding implicit Option unwrapping or overloading `attempt`:

```zs
const some(note) = selection else {
  return Option.none;
};

// note is available here, after the successful pattern match.
```

The pattern uses the same `some(binding)` vocabulary as `match`. The initializer
is evaluated once. A successful match introduces the binding into the following
scope. On a mismatch, the `else` runs and must leave the path that would otherwise
continue after the declaration; it cannot fall through with `note` uninitialized.
The success binding is not available inside the failure branch.

These are proposed source examples, not programs that should compile today.

## Motivating uses

Propagate absence explicitly:

```zs
function selectedNoteId(selection: Option<Note>): Option<u64> {
  const some(note) = selection else {
    return Option.none;
  };
  return Option.some(note.id);
}
```

Keep storage errors distinct from an absent record:

```zs
// Assumes findNote returns Option<Note> throws StorageError and this function
// declares a compatible error domain for both propagation and the local throw.
const some(note) = try findNote(id) else {
  throw NoteNotFound({ id });
};
```

Skip missing entries inside a loop:

```zs
for (const id of requestedIds) {
  const some(note) = findCachedNote(id) else {
    continue;
  };
  inspect(in note);
}
```

`return`, `throw`, `break`, and `continue` retain their ordinary targets and
legality rules. The `else` is not an implicit function or new return boundary.
Providing a value with `select` alone would not initialize a failed pattern and
must not satisfy the non-fallthrough requirement.

## Why this direction

- `attempt operation()` already materializes `Result<T, E>` for local inspection.
  Removing an Option wrapper and returning early would reverse that role.
- `try operation()` retains its current error-propagation meaning. If the
  operation returns `Option<T> throws E`, `try` produces `Option<T>`; it must not
  silently strip both the error effect and the optional layer.
- The failure branch states the policy: propagate absence, throw a chosen domain
  error, return a fallback from the function, or leave the current loop path.
- The syntax builds on existing patterns and explicit control-flow keywords,
  without turning ordinary absence into an implicit panic.

Alternatives discussed: `try option`, postfix `option?`, and a dedicated keyword
such as `unwrap`. None is approved by this handoff. Optional-propagation shorthand
can be reconsidered later if repeated `else { return Option.none; }` proves noisy.
Other enum patterns are a natural future extension, not an automatic first-tier
commitment.

## Ownership and implementation questions to settle

1. Confirm the initial grammar: contextual variants, optional qualification,
   nested payload destructuring, `const` versus `let`, and statement termination.
2. Define consuming and borrowing forms by reusing existing `match` capabilities;
   do not invent an implicit copy, retain, or owning conversion. Extracting a
   `view T` must preserve its owner and lifetime rather than produce owned `T`.
   The exact borrowed spelling was not chosen in the side conversation.
3. Define success/remainder destruction and mismatch cleanup, including temporary
   initializers, move-only payloads, ARC identities, and early-exit paths.
4. Prove definite initialization and non-fallthrough for every failure path,
   including nested branches. Give specific diagnostics for a continuing `else`
   and use of the success binding inside that branch.
5. Implement and test the agreed scope in both compiler paths, with source-located
   diagnostics, highlighting, hover, completion, and definition navigation. Review
   suspension composition explicitly rather than assuming synchronous lowering
   is sufficient for async functions.

Suggested first pressure test: replace repetitive Option-only `match` guards in
real Z/Zapp source without changing their ownership or error behavior. Keep the
language reference and website's implemented-feature documentation unchanged until
the capability actually lands.
