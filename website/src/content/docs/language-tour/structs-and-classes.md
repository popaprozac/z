---
title: Structs and classes
description: Choose value semantics or ARC-managed identity without separating data from behavior.
sidebar:
  order: 3
---

Z uses two primary aggregate shapes:

- `struct` declares a value.
- `class` declares ARC-managed reference identity.

Both can place behavior beside data. The choice is about ownership and identity,
not whether the type has methods.

## Structs are values

```z
struct Point {
  x: i32;
  y: i32;

  function sum(): i32 {
    return this.x + this.y;
  }
}

const point = Point({ x: 20, y: 22 });
const answer = point.sum();
```

A struct has a static native layout. Passing, storing, copying, borrowing, and
moving it follow the rules of its complete field graph.

Structs can define:

- Stored fields
- Instance methods
- Static methods and factories
- `deinit` for deterministic cleanup
- Generic parameters and trait conformance

## Field defaults

Struct fields may define independently evaluated defaults:

```z
struct RequestOptions {
  retries: i32 = 3;
  timeoutMilliseconds: i32 = 1000;
  headers: Array<String> = Array<String>();
}

const defaults = RequestOptions();
const equivalent = RequestOptions({});
const patient = RequestOptions({ timeoutMilliseconds: 5000 });
```

`RequestOptions()` is valid only because every field has a default. An owned
default such as `Array<String>()` creates fresh storage for every constructed
value—it is not shared module state.

Defaults cannot refer to `this` or sibling fields in the first tier. Class-field
defaults remain a future layer; class construction establishes every field
explicitly.

## Optional fields

`?` after a field name expresses optional presence:

```z
struct WindowOptions {
  url: String;
  title: String = "Z App";
  icon?: Image;
  parent: Option<WindowHandle>;
}
```

These field shapes are intentionally distinct:

| Declaration | May be omitted | Stored type |
| --- | --- | --- |
| `url: String` | No | `String` |
| `title: String = "Z App"` | Yes; evaluates the default | `String` |
| `icon?: Image` | Yes; becomes `none` | `Option<Image>` |
| `parent: Option<WindowHandle>` | No | `Option<WindowHandle>` |

Supplying an `Image` for `icon` contextually constructs `some(image)`. An
already constructed `Option<Image>` is also valid.

## Classes have shared identity

```z
class Session {
  readonly id: u64;
  name: String;
}

const session = new Session({ id: 1, name: "Primary" });
const same = session;
```

`new` makes heap-backed identity visible. Assigning `session` to `same` shares
the same ARC-managed instance; it does not deep-clone the fields.

Use a class when the design needs identity shared across owners, weak
references, or long-lived framework state. Do not choose a class merely because
the type has methods.

## Visibility and readonly storage

Fields are public unless marked `internal` or `private`. `internal` grants the
owning manifest-defined package access, while `private` grants only the
declaring aggregate. `readonly` prevents replacement or mutation through that
stored field after construction:

```z
readonly struct Coordinate {
  x: i32;
  y: i32;
}

readonly class Configuration {
  name: String;
  retries: i32;
}
```

Prefixing the aggregate applies `readonly` to all stored fields. This is shallow
field immutability, not automatic recursive freezing of every referenced value.

Constructors can use the same visibility boundary:

```zs
export readonly class Window {
  readonly id: String;
  internal readonly manager: Weak<WindowManager>;

  internal constructor(id: String, manager: Weak<WindowManager>) {
    this.id = move id;
    this.manager = manager;
  }
}
```

An unmarked or `public constructor` is public. `internal constructor` limits
construction to the owning manifest-defined package, while `private
constructor` limits it to the class and its static factories. The class remains
usable as a public parameter, field, or result type. External metadata and
editor call surfaces do not publish an inaccessible constructor signature.
Structs continue to use value construction and do not declare constructors.

A collection can independently carry readonly semantics:

```z
class Router {
  readonly handlers: readonly Map<String, Handler>;
}
```

The first `readonly` prevents replacing the map field. The second removes the
map's mutation surface while preserving owned storage and deterministic cleanup.

## Methods and receivers

Receiver capabilities communicate what a method does to its owner:

```z
struct Counter {
  value: i32;

  function read(): i32 {
    return this.value;
  }

  function increment(inout this): void {
    this.value = this.value + 1;
  }

  function finish(move this): i32 {
    return this.value;
  }
}
```

- An ordinary receiver inspects the value.
- `inout this` mutates caller-owned storage.
- `move this` consumes the receiver.

Static methods live on the nominal type without receiving an instance:

```z
struct Range {
  minimum: i32;
  maximum: i32;

  static function normalized(left: i32, right: i32): Range {
    if (left <= right) return Range({ minimum: left, maximum: right });
    return Range({ minimum: right, maximum: left });
  }
}
```

## Deterministic cleanup

A struct or class can define synchronous, infallible `deinit` behavior. It runs
exactly once when owned value storage ends or the final strong class reference
is released.

Fallible shutdown belongs in an explicit operation such as `close()`, not in
`deinit`. This lets callers handle failure while cleanup remains dependable.

:::note[Cost model]
A struct does not inherently allocate; its fields determine its storage and
cleanup cost. Constructing a class allocates ARC identity. Sharing that identity
retains it, and the final release runs `deinit`. Z does not silently deep-copy a
class graph.
:::

Next: [Functions and typed errors](/language-tour/functions-and-errors/).
