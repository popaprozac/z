---
title: Types and bindings
description: Machine values, owned abstractions, inference, mutation, and explicit conversions.
sidebar:
  order: 2
---

Z is statically and nominally typed. Local types are inferred when the
initializer makes them unambiguous; public contracts and storage boundaries
remain explicit.

```z
const answer = 42;          // inferred i32
const enabled = true;       // inferred boolean
const title = "Z Notes";    // inferred String
let attempts: usize = 0;
```

The familiar syntax does not imply JavaScript representations. `answer` is a
fixed-width integer, `enabled` is not truthy or falsy, and `title` owns immutable
UTF-8 bytes.

## `const` and `let`

- `const` creates an immutable lexical binding.
- `let` creates a mutable lexical binding.
- Z has no `var` and no function-scoped declaration hoisting.
- Assignment is a statement, not an expression.

```z
let revision = 1;
revision = revision + 1;

const name = "Draft";
// name = "Published"; // error: the binding is immutable
```

For a value `struct`, a `const` binding is immutable through its fields. For an
ARC `class`, `const` fixes the reference; the instance may still expose mutable
methods or fields. Ownership and member capabilities decide whether a
particular mutation is legal.

## Everyday type vocabulary

| Family | Z type | Meaning |
| --- | --- | --- |
| No value | `void` | A function produces no value |
| Boolean | `boolean` | Exactly `true` or `false`; no truthiness |
| Signed integers | `i8`, `i16`, `i32`, `i64` | Fixed-width two's-complement values |
| Unsigned integers | `u8`, `u16`, `u32`, `u64` | Fixed-width unsigned values; `u8` is a byte |
| Target-sized integers | `isize`, `usize` | Pointer-width signed/unsigned values |
| Floating point | `f32`, `f64` | Explicit IEEE-width floating values |
| Owned text | `String` | Immutable owned UTF-8 bytes |
| Borrowed C text | `cstring` | Non-owning NUL-terminated foreign text |
| Fixed collection | `T[N]` | Inline fixed-size owned array |
| Growable collection | `Array<T>` | Move-owned contiguous buffer |
| Borrowed collection | `Slice<T>` | Non-escaping pointer/length view |
| Optional value | `Option<T>` | Built-in `some`/`none` tagged value |
| Typed outcome | `Result<T, E>` | Built-in `success`/`failure` tagged value |

Primitive machine values use lowercase names. Owned, nominal, or library
abstractions generally use `PascalCase`. `cstring` is the deliberate exception:
it describes a primitive foreign view, not a Z-owned string.

There is currently no `any`, general structural object type, arbitrary-width
integer, or ordinary user-written nullable union.

## When inference applies

Inference keeps local code concise:

```z
const point = Point({ x: 20, y: 22 });
const values = Array<i32>(20, 22);
const maybeName = Option.some("Z");
```

Types remain explicit where they communicate a durable contract:

- Function parameters and results
- Public exported values
- Struct and class fields
- Uninitialized `out` storage
- Empty collections without element evidence
- Foreign ABI boundaries

```z
export const DEFAULT_PORT: u16 = 34115;

function measure(in text: String): usize {
  return text.byteLength;
}
```

This keeps implementation details inferable without letting a public API change
silently when an initializer is edited.

## Conditions require booleans

Z does not use JavaScript truthiness:

```z
if (values.length > 0) {
  inspect(values[0]);
}
```

Integers, strings, options, and nullable native values are not conditions.
Compare explicitly, or match an `Option<T>`.

## Optional values and native nullability

Use `Option<T>` for absence in native Z APIs:

```z
const selected: Option<i32> = Option.some(42);
const missing: Option<i32> = Option.none;
```

`T | null` is reserved for representable nullable native references and handles.
It preserves an honest foreign ABI rather than introducing null into every Z
value. Convert to an option when that produces a better Z-facing API:

```z
const window = Option.fromNullable(app.keyWindow);
```

## Explicit integer conversion

Calling an integer type constructs the same mathematical value in that type:

```z
const byte: u8 = 42;
const widened = i32(byte);
const nativeCount = isize(values.length);
const narrowed = u8(widened);
```

If every source value fits, conversion lowers to a native cast. Otherwise Z
checks the runtime value and traps when it is out of range. Integer literals are
contextually typed and produce a compile-time error when they do not fit.

This is intentionally different from TypeScript's `as`: a Z type construction
performs a real conversion rather than merely asserting a static interpretation.

:::note[Cost model]
Primitive values normally use their direct native representation. Fixed arrays
store their elements inline. `Array<T>` owns growable storage, `String` owns
UTF-8 storage, and `Slice<T>` is a non-owning pointer/length descriptor.
Checked indexing and narrowing conversions may add runtime checks.
:::

Next: [Structs and classes](/language-tour/structs-and-classes/).
