---
title: Z for TypeScript developers
description: Keep the familiar syntax while replacing JavaScript assumptions with Z's native semantics.
sidebar:
  order: 2
---

Z deliberately looks familiar to TypeScript developers. That familiarity is an
on-ramp, not a promise of JavaScript behavior.

The fastest way to become comfortable in Z is to keep your syntax intuition and
replace your runtime intuition.

## The essential translation

| TypeScript intuition | Z semantics |
| --- | --- |
| Objects are garbage-collected references | `struct` is a value; `class` is ARC-managed identity |
| A `number` holds ordinary numeric values | Integers and floats have explicit widths such as `i32`, `u64`, and `f64` |
| Values participate in truthiness | Conditions require `boolean` |
| Object types are usually structural | User-defined Z types are nominal |
| Assignment and calls freely share references | Ownership, borrowing, and copying are checked |
| `throw` uses JavaScript exception unwinding | `throws E` is a typed function error channel |
| `async` produces a Promise | Async calls produce owned `Task<T, E>` values |
| `null` and `undefined` are everyday absence | Native Z absence uses `Option<T>`; foreign nullability stays explicit |
| Native integration needs a wrapper layer | Representable headers can be imported directly |

## Bindings and mutation

`const` and `let` still describe the local binding, but mutation is also subject
to the value's ownership capability.

```z
struct Counter {
  count: i32;
}

function increment(inout counter: Counter): void {
  counter.count += 1;
}

let counter = Counter({ count: 0 });
increment(inout counter);
```

`inout` is explicit at the declaration and call because the operation may
mutate caller-owned storage. Immutable `in` calls can usually omit the call-site
marker; `move`, `copy`, `out`, and `inout` remain visible because they have
consequential ownership or storage effects.

## Structs and classes

Use a `struct` for value semantics and a `class` for shared identity:

```z
struct Note {
  id: u64;
  title: String;
  active: boolean = true;
}

class Session {
  readonly id: u64;
}

const note = Note({ id: 1, title: "Draft" });
const session = new Session({ id: 1 });
```

The `new` keyword deliberately signals ARC-managed class identity. Struct
construction does not use `new` and may remain in local value storage.

Z structs can contain methods and deterministic `deinit` behavior; classes are
not required merely to place behavior beside data.

## Absence and nullability

Native Z APIs normally express absence with `Option<T>`:

```z
const selected: Option<Note> = notes.first();

return match (selected) {
  some(note) => note.id;
  none => 0;
};
```

`T | null` is important at foreign boundaries where null is part of the real
ABI. It is not the default representation of absence throughout ordinary Z
programs. `Option.fromNullable(value)` converts a nullable foreign result when
matching an option is the clearer API.

## Typed errors

Z keeps the readable `throw` vocabulary while making the error channel part of
the function type:

```z
struct LoadError {
  code: i32;
}

function loadNote(id: u64): Note throws LoadError {
  if (id == 0) throw LoadError({ code: 1 });
  return Note({ id, title: "Ready" });
}

const note = try loadNote(42);
const result = attempt loadNote(42);
```

- `try` propagates failure through the enclosing function's typed error channel.
- `attempt` keeps a `Result<T, E>` so the caller can handle it locally.
- `return` produces success; `throw` produces failure.

There is no `Ok(...)` or `Err(...)` ceremony in ordinary source.

## Pattern matching and expression blocks

`match` is exhaustive and may produce a value:

```z
const message = match (result) {
  success(note) => note.title;
  failure(error) => `load failed: ${error.code}`;
};
```

Use `_` as the final catch-all pattern when the remaining cases do not matter:

```z
return match (value) {
  string(text) => text;
  _ => "unsupported";
};
```

Inside a value-producing block, `select` supplies the local expression value.
`return` always exits the enclosing function, even when nested deeply. This
avoids assigning two different meanings to the same keyword.

## Ownership is part of the call

This is the largest semantic departure from TypeScript:

```z
inspect(document);             // immutable borrow inferred
revise(inout document);        // exclusive mutation
archive(move document);        // transfer; source becomes unavailable
const snapshot = copy draft;   // explicit independent copy
```

`move` does not copy a value and `copy` does not transfer it. A `view T` is a
non-owning projection that cannot outlive or invalidate its owner.

Read [Ownership capabilities](/language-tour/ownership/) before writing
resource-heavy or cross-thread code.

## Async work is owned

An async function returns a task-shaped operation rather than a JavaScript
Promise with implicit detached lifetime:

```z
async function fetchCount(): i32 {
  return 42;
}

async function main(): i32 {
  const pending = task fetchCount();
  const count = await pending;
  return count;
}
```

`task` starts a structured child task. Scopes join their children rather than
silently abandoning them. Native OS-thread work is a separate operation through
`thread.spawn`; executor placement such as `thread.main` does not imply creating
a new thread.

## Imports can cross the native boundary

Z source modules use familiar imports:

```z
import { translate as movePoint } from "./geometry.zs";
```

The same syntax can name a native header:

```z
import AppKit from "AppKit/AppKit.h";

const app = AppKit.NSApplication.sharedApplication;
```

That import is checked through Clang rather than interpreted as a Z or
JavaScript module. See [Native interop](/interop/) for the safety tiers.

## Rules worth remembering

- Use `.zs` for Z source and `.zd` for foreign semantic contracts.
- Use `boolean`, not JavaScript truthiness.
- Choose numeric widths deliberately.
- Prefer `Option<T>` for native Z absence.
- Use `struct` unless shared identity is part of the design.
- Treat `move`, `copy`, `inout`, and `out` as meaningful effects, not decoration.
- Expect the compiler to reject escaping borrows, overlapping mutation, and
  unsafe cross-thread capture.
- Check the [implementation status](/reference/status/) before depending on an
  advanced composition in pre-alpha code.

Next, take the [language tour](/language-tour/) or build a program with
[Getting started](/getting-started/).
