---
title: Language at a glance
description: The core shapes that make Z readable and native.
sidebar:
  order: 1
---

Z uses a TypeScript-inspired surface with native, value-oriented semantics.
Familiar punctuation is an on-ramp; it does not imply garbage collection,
structural typing, truthiness, or JavaScript numbers.

Z-authored types use `PascalCase`; functions, methods, fields, locals, and
module exports use `camelCase`; source files use lowercase kebab-case. Native
imports and explicit ABI exports preserve their foreign spelling, so a C symbol
such as `sqlite3_open` remains recognizable at the boundary.

## Values and identities

`struct` defines a value. `class` defines ARC-managed reference identity.

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

Struct defaults may be omitted and explicitly overridden. Classes use `new` so
heap-backed reference identity is visible at construction.

## Typed errors

Functions return success with `return` and typed failure with `throw`:

```z
struct LoadError { code: i32; }

function load(id: u64): Note throws LoadError {
  if (id == 0) throw LoadError({ code: 1 });
  return Note({ id, title: "Ready" });
}

const note = try load(42);           // propagate failure
const result = attempt load(42);     // retain Result<Note, LoadError>
```

`try` propagates through the function's error channel. `attempt` materializes
the result for local handling.

## Pattern matching

```z
return match (result) {
  success(note) => note.id;
  failure(error) => -error.code;
};
```

Match is exhaustive and may produce an expression value. `select` supplies a
value to a local expression block; `return` always exits the enclosing function.

## Native-sized types

Z uses explicit integer and floating-point widths (`i32`, `u64`, `f32`, `f64`),
plus `usize` and `isize` for target-sized values. `boolean`, `String`, `cstring`,
`Option<T>`, arrays, slices, maps, and sets provide the everyday foundation.
