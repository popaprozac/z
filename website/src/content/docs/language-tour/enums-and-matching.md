---
title: Enums and matching
description: Model finite states and typed payloads, then handle them exhaustively.
sidebar:
  order: 5
---

Z enums are nominal tagged values. A variant may carry no payload or one typed
payload:

```z
struct User {
  id: u64;
  name: String;
}

enum SessionState {
  loading,
  ready User,
  failed String,
}
```

Construction uses the qualified variant name:

```z
const loading = SessionState.loading;
const ready = SessionState.ready(User({ id: 1, name: "Ada" }));
```

`Enum.variant(value)` is construction, just as `Struct({ fields })` is value
construction. Matching uses the inverse shape to bind the payload.

## Exhaustive matching

```z
const label = match (ready) {
  loading => "Loading";
  ready(user) => copy user.name;
  failed(message) => message;
};
```

Every possible variant must be handled. If a new variant is added later, the
compiler points to matches that need a decision.

Match does not require repeating the enum type in every arm because the subject
already establishes the nominal variant set.

## Catch all remaining variants

Use `_` as the final arm when only selected variants matter:

```z
return match (state) {
  ready(user) => user.id;
  _ => 0;
};
```

The wildcard binds no payload. It must be last; following arms would be
unreachable. A consuming match still destroys an owned payload discarded by
`_`.

Use `_` deliberately. Listing every variant is usually better when each state
has meaning and adding a new state should force a review.

## Consuming and borrowed matches

`match (value)` consumes an ownership-bearing subject when needed. Use
`match (in value)` to inspect it without taking ownership:

```z
function inspect(in state: SessionState): u64 {
  return match (in state) {
    ready(user) => user.id;
    _ => 0;
  };
}
```

The distinction matters when payloads own strings, resources, or ARC identities.
A borrowed payload remains tied to the enum owner and cannot escape it.

## `Option` and `Result` use the same model

`Option<T>` is a built-in enum-shaped value with `some` and `none`:

```z
return match (selection) {
  some(value) => value;
  none => 0;
};
```

`Result<T, E>` has `success` and `failure`:

```z
return match (attempt loadCount(42)) {
  success(value) => value;
  failure(error) => -error.code;
};
```

These variant names are contextual. They are not magical success and failure
functions, and a user-defined enum can choose its own variant vocabulary.

## Match as an expression

Each arm can produce the enclosing match value directly:

```z
const message: String = match (state) {
  loading => "Loading";
  ready(user) => copy user.name;
  failed(error) => error;
};
```

For a multi-statement arm, use `select` to provide the match value:

```z
const message = match (state) {
  loading => "Loading";
  ready(user) => {
    const prefix = "Signed in";
    select `${prefix}: ${user.name}`;
  }
  failed(error) => error;
};
```

`select` targets the local value-producing block. `return` still exits the
enclosing function and `throw` still exits through its typed error channel.
There is no implicit last-expression return from a block.

A match can also assign to existing storage:

```z
let label = "Waiting";
label = match (in state) {
  loading => "Loading";
  ready(user) => copy user.name;
  failed(error) => copy error;
};
```

This direct assignment form also works for fields, including captured class
state, in the native synchronous compiler. An arm that returns or throws does
not replace the destination. On success, an old owned value is cleaned up before
the selected replacement takes its place.
Owned indexed or computed destinations are still outside this native tier;
the compiler rejects them rather than skip old-value cleanup.

You can also construct an enum payload directly from a match:

```z
enum Response { text String, empty, }

function respond(selection: Option<String>): Response {
  return Response.text(match (selection) {
    some(text) => { select text; }
    none => "missing";
  });
}
```

Only the selected arm runs. Its `select` supplies the payload; an explicit
`return` still exits `respond` instead. Cleanup applies on both paths.

The native compiler currently supports this enum-constructor shape in bindings
and returns, including nested enum constructors. General nested matches in
arbitrary call arguments and short-circuit expressions remain a later tier.

Payload-free enums support nominal `==` and `!=`. Payload-bearing enums use
`match`; Z does not invent equality semantics for arbitrary payload graphs.

:::note[Cost model]
An enum uses a tag plus whatever storage its largest payload requires, unless a
proven niche representation applies. Matching lowers to tag selection. It does
not require dynamic type lookup or allocation merely because a payload exists.
:::

Next: [Ownership capabilities](/language-tour/ownership/).
