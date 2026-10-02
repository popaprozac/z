---
title: Functions and typed errors
description: Explicit contracts, inferred local values, and errors that remain ordinary typed data.
sidebar:
  order: 4
---

Z functions declare parameter and result types explicitly:

```z
function add(left: i32, right: i32): i32 {
  return left + right;
}
```

Local variables can infer their types, but a function signature is a durable
contract. Parameter capabilities such as `in`, `inout`, `out`, and `move` are
part of that contract as well.

## Parameters describe access

```z
struct Counter {
  value: i32;
}

function inspect(in counter: Counter): i32 {
  return counter.value;
}

function increment(inout counter: Counter): void {
  counter.value = counter.value + 1;
}

let counter = Counter({ value: 41 });
const before = inspect(counter);
increment(inout counter);
```

Immutable `in` is normally inferred at the call site, though writing
`inspect(in counter)` explicitly is valid. Writable `inout`, initializing
`out`, and consuming `move` stay explicit at both ends because they change the
caller's storage or ownership.

The complete capability matrix is in
[Ownership capabilities](/language-tour/ownership/).

For callback parameters, `in` alone is not a guarantee that the implementation
never retains a function value. See
[Borrowed captures](/language-tour/closures-and-function-values/#borrowed-captures-by-default)
for the source-body proof that makes stack-backed inline callbacks safe.

## Success and failure

A throwing function names its error type:

```z
struct LoadError {
  code: i32;
}

function loadCount(id: i32): i32 throws LoadError {
  if (id < 0) throw LoadError({ code: id });
  return id;
}
```

- `return value` completes successfully.
- `throw error` completes with the declared error.
- `try operation()` propagates failure.
- `attempt operation()` keeps the outcome for local inspection.

The error may be any value compatible with the declared `E`. Z does not require
every error to inherit from or implement one universal error type. Libraries
can define a trait when they need a shared application-level contract.

## Propagate with `try`

```z
function loadPair(): i32 throws LoadError {
  const first = try loadCount(20);
  const second = try loadCount(22);
  return first + second;
}
```

On success, `try` produces the ordinary result value. On failure, it transfers
the error through the enclosing function's compatible error channel and cleans
up already-live owned values.

`try` is an expression, so it can appear where the success value is needed:

```z
const total = add(try loadCount(20), try loadCount(22));
```

Calls still evaluate in source order.

## Inspect with `attempt`

```z
const outcome = attempt loadCount(-1);

return match (outcome) {
  success(value) => value;
  failure(error) => -error.code;
};
```

`attempt` materializes `Result<T, E>`. `success` and `failure` are the built-in
result variants; they are not global function calls or general reserved words.

The same `Result<T, E>` type can be written explicitly in a field, parameter, or
return annotation. It does not require a throwing call to exist nearby.

## Async errors remain explicit

Suspension and propagation are written together:

```z
async function refresh(): i32 throws LoadError {
  const first = try await fetchCount(20);
  const second = try await fetchCount(22);
  return first + second;
}
```

`await` resolves the task operation; `try` propagates its typed failure. Z does
not hide either effect merely because the function is asynchronous.

## Cleanup-bearing errors

Error values may own `String`, ARC identities, Z structs, or contracted native
resources. Throwing transfers that owner into failure storage. Propagation,
matching, discard, and cancellation destroy it exactly once.

:::note[Cost model]
Z typed errors lower through tagged result storage rather than native exception
unwinding. A cleanup-free `Result` is an allocation-free tag and payload. The
payload's own type still determines copying, retaining, or cleanup cost.
:::

Next: [Enums and matching](/language-tour/enums-and-matching/).

## Place hot and cold code

Mark a small function every hot path calls `inline`, and one that runs rarely
`cold`:

```z
inline function clamp(value: i32, low: i32, high: i32): i32 {
  return value < low ? low : value > high ? high : value;
}

cold function reportFailure(code: i32): void {
  console.error("failed with", code);
}
```

An `inline` function is copied into every caller, so it cannot call itself;
a `cold` function stays out of line and is optimized for size. Both are
keywords only directly before `function`, and neither changes what the code
does.
