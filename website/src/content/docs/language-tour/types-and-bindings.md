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

## Numeric literals

Use hexadecimal or binary when a bit pattern is easier to review than decimal:

```z
const mask: u64 = 0xFFF8_0000_0000_0000;
const flags: u8 = 0b1010_0101;
const capacity: usize = 1_024;
const minimum: i64 = -0x8000_0000_0000_0000;
const offsets: i32[0x3] = [10, 20, 12];
```

`0X` and `0B` also work. Underscores separate digits; they cannot follow the
prefix, repeat, or appear at the end. Decimal fractions and exponents may also
separate digits: `1_024.5_0e+0_1`. A leading zero remains decimal (`010` is ten),
and `e` is an ordinary digit inside hexadecimal integers.

These are alternate spellings, not conversions or unchecked bit casts. The
normal contextual range checks apply: `const byte: u8 = 0x100;` is an error.

That context also reaches ternary arms and shift literals. The compiler knows
the integer width before it checks the shift:

```z
type TagBits = u64;
function tag(enabled: boolean): TagBits {
  return enabled ? 0xFFFE << 48 : 0;
}
const mask: TagBits = 0xFFFE << 48;
```

Bindings, assignments, returns, arguments, and struct fields can supply this
context. Already-typed values keep their types: an `i32` variable is not silently
widened to `u64`. Use `u64(value)` when you intend a conversion. Without numeric
context, `true ? 7 : 6` remains `i32`.

The other numeric operand can supply context too, including through nested
literal-only ternaries:

```z
let index: usize = 0;
index = index + (wide ? 2 : 1);
const next = (wide ? 2 : 1) + index; // usize
```

The conditions remain boolean and run once in normal expression order. A
branch containing an already-typed value does not gain an implicit conversion.

## Checked arithmetic and wrapping shifts

Ordinary integer arithmetic, including `<<`, is checked in every build mode.
Intentional result overflow is explicit:

```z
const word: u32 = 3;
const shifted = word.wrappingShiftLeft(31); // 0x8000_0000; word stays 3
const negative: i32 = -1;
const signBit = negative.wrappingShiftLeft(31); // -2147483648
```

Every integer type has `wrappingShiftLeft(count: usize)`, returning its exact
type. High result bits are discarded and low bits are zero-filled; signed
results preserve the resulting two's-complement bits. There is no mutation,
allocation, or reference counting.

The **count does not wrap**: it must be less than the receiver's bit width.
For `u32`, valid counts are 0 through 31. Known invalid counts are diagnosed;
dynamic invalid counts trap. The count is never masked or reduced modulo 32.
This is not rotation. Ordinary `<<` additionally checks that the complete
mathematical result fits. A valid constant-count wrapping shift can optimize
to one native shift.

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

Value structs may make omission part of their construction contract with
`field?: T`. The field is stored as `Option<T>`: omission produces `none`, a
direct `T` is lifted to `some`, and an already-computed `Option<T>` transfers
without another wrapper.

```zs
struct NoteDraft {
  title: String;
  subtitle?: String;
}

const plain = NoteDraft({ title: "Draft" });
const subtitle: Option<String> = Option.some("Local only");
const detailed = NoteDraft({
  title: "Draft",
  subtitle: move subtitle,
});
```

Use `field: Option<T>` when callers must explicitly supply either `some` or
`none`; use `field?: T` when omission itself is a supported construction shape.

## Explicit numeric conversion

Calling a numeric type constructs the same mathematical value in that type:

```z
const byte: u8 = 42;
const widened = i32(byte);
const nativeCount = isize(values.length);
const narrowed = u8(widened);
const nativeWidth = f64(narrowed);
```

If every source value fits exactly, conversion lowers to a native cast.
Otherwise Z checks the runtime value and traps rather than change it. Converting
a float to an integer requires a finite, integral, in-range value; converting an
integer to a float rejects precision loss. Deliberate rounding is visible:

```zs
import math from "std/math";

const pixels = u32(math.trunc(measuredWidth));
```

This is intentionally different from TypeScript's `as`: a Z type construction
performs a real conversion rather than merely asserting a static interpretation.

## Signed-integer bits

Use the same `toBits()` / `fromBits()` pair to store a signed integer's
representation in an unsigned value:

```zs
const negative: i32 = -42;
const bits: u32 = negative.toBits(); // 0xFFFF_FFD6
const restored = i32.fromBits(bits); // -42
```

The pairs are `i8` ↔ `u8`, `i16` ↔ `u16`, `i32` ↔ `u32`, `i64` ↔ `u64`, and
`isize` ↔ `usize`. The signed value provides `toBits`; its signed type provides
`fromBits`. Unsigned integers are already bit representations and have no
identity bit methods.

Every two's-complement pattern is valid. Numeric construction remains checked:
`u32(negative)` cannot represent a negative mathematical value, whereas
`negative.toBits()` preserves its bits. These methods evaluate the operand once,
leave it usable, allocate nothing, and work in async frames. `fromBits` supplies
unsigned context to literals; typed inputs must match exactly. They do not
convert byte order or reinterpret objects, enums, or pointers.

## Floating-point bits

Use `toBits()` / `fromBits()` when you want the exact representation rather than
a numeric conversion. No import is required:

```zs
const value: f64 = 1.0;
const bits = value.toBits(); // u64: 0x3FF0_0000_0000_0000
const restored = f64.fromBits(bits);
const negativeZero = f32.fromBits(0x8000_0000);
const sign = negativeZero.toBits(); // u32
```

The pairs are `f32` ↔ `u32` and `f64` ↔ `u64`. `fromBits` contextually types
integer literals; an already-typed argument must have exactly the matching
unsigned type. All IEEE 754 patterns are valid, including infinities and NaNs.
A direct round trip preserves NaN payloads and signed zero; arithmetic need
not preserve NaN payloads.

These methods evaluate their input once without consuming it, allocating, or
requiring `unsafe`. They work in async frames too. They are not endian conversion,
serialization, or general-purpose casts of objects and pointers.

:::note[Cost model]
Primitive values normally use their direct native representation. Fixed arrays
store their elements inline. `Array<T>` owns growable storage, `String` owns
UTF-8 storage, and `Slice<T>` is a non-owning pointer/length descriptor.
Checked indexing and representability-risk conversions may add runtime checks.
:::

Next: [Structs and classes](/language-tour/structs-and-classes/).
