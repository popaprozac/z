---
title: Closures and function values
description: Store behavior, capture local state, preserve typed effects, and make escaping ownership explicit.
sidebar:
  order: 10
---

Functions and closures are typed values in Z. Arrow closures use a familiar
TypeScript-shaped syntax:

```z
const offset = 2;
const add = (value: i32): i32 => value + offset;
```

A block-bodied closure uses `return` to complete that closure invocation:

```z
let total = 0;
const accumulate = (value: i32): i32 => {
  total = total + value;
  return total;
};
```

Here `return` targets `accumulate`, not the function in which the closure was
created. `select` remains reserved for local value-producing control-flow
blocks inside that closure.

## Function types

Parameter names make signatures readable but do not create a structural object
type:

```z
type Operation = (left: i32, right: i32) => i32;

function apply(
  in operation: Operation,
  left: i32,
  right: i32
): i32 {
  return operation(left, right);
}
```

A compatible named function or closure can initialize `Operation`:

```z
function add(left: i32, right: i32): i32 {
  return left + right;
}

const direct: Operation = add;
const doubled: (value: i32) => i32 = (value) => value * 2;
```

Parameter capabilities are part of the function type. A callback accepting
`inout value: T` is a different contract from one accepting `in value: T`.

## Borrowed captures by default

An ordinary closure borrows captured local state. It remains valid only where
the destination proves the capture cannot outlive that state:

```z
const item = store.at(0);
const observed = inspect(() => item.value);
store.append(next); // valid after inspect and the borrow end
```

This gives synchronous higher-order APIs concise call sites while preserving
the same escape and invalidation checks as explicit views.

Borrowing state is not taking a snapshot:

```z
let total = 0;
const add = (value: i32): void => {
  total = total + value;
};
add(20);
add(22); // total is 42

const read = (): i32 => total;
total = 100;
const observed = read(); // 100, not the value when read was created
```

These synchronous block and scalar-reading expression forms execute
through both compiler paths with stack environments and no heap allocation.
Expression closures may also mutate borrowed cleanup-free state by calling an
`inout` helper. `move` gives the callback its own
captured value instead; mutations to that owned state persist across calls and
do not reassign the parent's Copy scalar. This applies to expression bodies as
well as block bodies. Synchronous block callbacks can return owned values and
declare their own `throws E`, independently of the enclosing function:

```z
const describe = (count: i32): String => {
  if (count == 0) return "No notes";
  return `Notes: ${count}`;
};
const title = describe(42);
```

Each invocation cleans up its own locals and by-value parameters, except
ownership transferred out of those bindings. Borrowed cleanup-bearing
captures and asynchronous block lowering remain tracked in [implementation
status](/reference/status/).

Both compilers inspect the receiving Z helper, not just the `in` spelling:

```z
function inspect(in operation: () => i32): i32 {
  return operation();
}
```

Direct invocation and forwarding through proven synchronous named helpers are
accepted. A helper that returns, stores, aliases, or captures its callback
cannot receive an inline stack-backed environment. When retention is intended,
pass an owned closure:

```z
function preserve(in operation: () => i32): () => i32 {
  return operation;
}

const count = 42;
const saved = preserve(move (): i32 => count);
```

The helper borrows the owned callable and returns a retained copy. Recursive,
dynamic, raw, or deferred forwarding is not inferred nonescaping in this tier.
This is proof about a known implementation, not a structural function-type
property or a runtime escape check. Received Objective-C blocks with ARC-backed
adapter environments remain retainable under their native ownership contract.

## Owned captures with `move`

Use a `move` closure when the callable must escape its defining scope:

```z
function makeCounter(start: i32): () => i32 {
  let current = start;

  const counter: () => i32 = move () => {
    current = current + 1;
    return current;
  };

  return counter;
}
```

`move` describes an owned capture environment. Capturing a unique owned value
transfers it, capturing an ARC identity retains shared identity, and capturing a
cleanup-free copy value stores its ordinary value snapshot.

Owned closure environments use ARC. Copying a closure value shares the same
environment and therefore the same captured mutable state:

```z
const counter = makeCounter(40);
const sameCounter = counter;

const first = counter();      // 41
const second = sameCounter(); // 42
```

This is shared closure identity, not two independent deep clones.

## Throwing function values

Error effects remain part of the callable type:

```z
struct ResponseError {
  status: i32;
}

type ResponseValidator = (status: i32) => i32 throws ResponseError;

function validate(
  in operation: ResponseValidator,
  status: i32
): i32 throws ResponseError {
  return try operation(status);
}
```

A contextually typed closure may use `throw` without restating the effect on the
literal. Calling the stored function still requires `try` or `attempt`; storage
does not erase failure.

Synchronous and asynchronous callable types are distinct even when their
ordinary parameters and results match. Executor contracts such as
`on thread.main` and `on thread.any` are also part of callable identity; they
constrain where construction, capture, storage, and invocation are legal rather
than scheduling work implicitly.

## Breaking class/closure cycles

An ARC class stored strongly by its own closure would form a cycle. Capture a
`Weak<T>` when the closure should not keep that identity alive:

```z
const owner = weak controller;
const handler: () => i32 = move (): i32 => {
  const upgraded = attempt owner.upgrade();
  return match (upgraded) {
    success(current) => current.id;
    failure(expired) => -1;
  };
};
```

`upgrade()` produces a new strong owner or throws `WeakExpired`. Automatic ORC
cycle collection remains future work, so deliberate weak edges matter today.

:::note[Cost model]
A noncapturing closure can lower to a direct function pointer where the ABI
allows it. A non-escaping borrowed closure need not own captured state. An
escaping captured closure uses an ARC environment; copying the closure retains
that environment. The captured values determine additional retain, move, and
cleanup costs.
:::

Runnable examples:
[function values](https://github.com/popaprozac/z/blob/main/examples/language/basics/function-values.zs),
[owned closures](https://github.com/popaprozac/z/blob/main/examples/language/ownership/owned-closures.zs),
and [throwing callables](https://github.com/popaprozac/z/blob/main/examples/language/basics/throwing-function-values.zs).

Next: [Generics and traits](/language-tour/generics-and-traits/).
