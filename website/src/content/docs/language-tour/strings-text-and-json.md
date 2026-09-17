---
title: Strings, text, and JSON
description: Work with owned UTF-8, explicit byte operations, efficient construction, and exact JSON numbers.
sidebar:
  order: 12
---

`String` is immutable owned UTF-8 text. Z does not inherit JavaScript's UTF-16
string representation or character indexing rules.

Double and single quotes create ordinary strings. Backticks create template
strings with `${expression}` interpolation:

```z
const doubleQuoted = "double";
const singleQuoted = 'single';
const answer = 42;
const message = `answer=${answer}`;
```

## Console output is explicit

```z
import console from "std/console";

console.log(message);
console.debug(`slow operation: ${milliseconds}ms`);
console.error(error);
```

The standard console can format Z values for development and diagnostics. It is
a standard module rather than a compiler-global object.

## Storage units are named

String operations make byte semantics visible:

```z
const source = "export function main() {}";
const bytes: usize = source.byteLength;
const first: u8 = source.byteAt(0);
const keyword = source.copyBytes(0, 6);

if (source.isEmpty) console.log("empty source");
```

- `byteLength` is constant-time.
- `byteAt(index)` bounds-checks the byte position.
- `copyBytes(start, end)` uses a half-open range and returns an independent
  owned `String`.
- Byte-range endpoints must also be valid UTF-8 boundaries.

`String.length` is reserved for a future Unicode grapheme-counting API. Z does
not label UTF-8 byte count or JavaScript UTF-16 code units as character length.

String equality compares exact UTF-8 byte sequences. It performs no locale
folding, Unicode normalization, or coercion.

## `String` and `cstring` are different

`cstring` is a borrowed NUL-terminated native view:

```z
const boundary: cstring = "native literal";
const owned = String.from(boundary);
```

Use `cstring` at C boundaries that genuinely require it. Convert to `String`
when the value must be owned independently or may outlive the native source.

## Decode a byte buffer

```z
import { Utf8Error } from "std/text";

function decode(bytes: Slice<u8>): String throws Utf8Error {
  return try String.fromBytes(bytes);
}
```

Pass a `Slice<u8>`, `Array<u8>`, or fixed byte array. Input is borrowed, so it
stays usable on success and failure; no `in` or `move` is needed. The returned
String owns a copy and remains valid after the original buffer changes or dies.

UTF-8 is validated strictly. Empty input succeeds, embedded NUL bytes survive,
and Unicode is not normalized. Catch locally with `attempt`, or propagate with
`try`. `Utf8Error.byteOffset` identifies the zero-based start of the malformed or
truncated sequence, immediately after the valid prefix.

Cost: a validation scan plus a copy, with one allocation for nonempty valid
input. Invalid and empty input do not allocate output storage. Other encodings
and an explicitly consuming conversion are future work, not hidden behavior of
this method.

## Build repeated text with `TextBuffer`

Repeated template concatenation can create avoidable intermediate strings.
Use the move-only standard text builder for incremental construction:

```z
import { TextBuffer } from "std/text";

let output = TextBuffer();
output.append("answer=");
output.appendAscii(52);
output.appendAscii(50);
output.appendCodePoint(128640); // U+1F680 ROCKET

const text = output.finish();
```

`finish()` consumes the mutable buffer and returns an immutable `String`.
`appendAscii` validates the ASCII range, and `appendCodePoint` validates and
encodes one Unicode scalar value.

## Dynamic JSON values

JSON is an explicit standard module:

```z
import json from "std/json";

function normalize(in source: String): String throws json.JsonError {
  const value = try json.parse(source);
  return json.stringify(in value);
}
```

`JsonValue` is an owned recursive enum with `nullValue`, `boolean`, `number`,
`string`, `array`, and `object` variants. Arrays own their elements and objects
own `Map<String, JsonValue>` entries, so normal Z ownership and matching rules
apply.

JSON numbers use nominal `JsonNumber`, not `f64`. Parsing preserves the exact
validated spelling, so large integers, decimals, and exponents can round-trip
without silent floating-point rounding.

Convert deliberately when arithmetic is needed:

- `number.toU64()`
- `number.toI64()`
- `number.toF64()`
- `number.text()` for the exact owned spelling

## Typed JSON codecs

Application structs can use a derived typed codec:

```z
import json from "std/json";

struct User {
  id: u64;
  name: String;
  active: boolean = true;
  tags: Array<String>;
}

function decodeUser(in source: String): User throws json.JsonError {
  return try json.decode<User>(source);
}

function encodeUser(in user: User): String throws json.JsonEncodeError {
  return try json.encode(in user);
}
```

Integers decode directly into the requested width, so a `u64` ID does not pass
through an imprecise `f64`. Missing fields with defaults evaluate those
defaults; other missing fields fail. Unknown fields are skipped recursively,
duplicate known fields are rejected, and encoding follows declaration order.
JSON keys retain the declared Z field names, including names such as `signed`
or `unsigned` that need an internal spelling change in generated C. That
backend-only change adds no runtime conversion or storage.

`Option<T>` fields use JSON `null` for `none` and a non-null JSON value for
`some(value)`. Encoding `none` writes the key with a `null` value; it does not
omit the key. Missing fields still require a declared default:

```zs
struct Request {
  directory: Option<String>; // required key; accepts null
  label: Option<String> = Option<String>.none; // may be omitted
}
```

:::caution[Current typed-codec boundary]
The derived encoder and decoder support public, non-optional `String`,
`boolean`, signed or unsigned integer, `f64`, nested value structs, and arrays of
strings or those structs. Readonly arrays and recursive trees through arrays
are supported too, as are `Option<T>` fields wrapping those supported types.
Stage 0 and the fixed-point compiler emit direct streaming codecs without an
intermediate dynamic tree. Optional property syntax (`?`), arrays of Options,
`f32`, other collections, classes, custom constructors, and custom
field-name policies remain later tiers. Nested `Option<Option<T>>` is rejected:
JSON `null` cannot distinguish `none` from `some(none)`.
Dynamic `json.parse` and `json.stringify` cover broader JSON shapes today.

The decoder also accepts `f64` fields (including nested structs and
`Option<f64>`). JSON fractions and exponents round to binary floating point;
overflow to infinity is a decoding error. Very small values may round to zero.
Conversion uses the C numeric locale without changing the process-wide locale.
Typed encoding always throws `JsonEncodeError`, even for integer/string-only
structs. Finite `f64` values round-trip, including negative zero. NaN and
infinities fail with a `path` such as `items[3].position.x` and a `message`;
they never silently become `null`. Use `try json.encode(in value)` to
propagate or `attempt` to inspect the error. Failure frees the partial output
without consuming or changing the input. Dynamic `json.stringify` remains
nonthrowing because its input contains validated numbers. Use `JsonNumber`
for lossless forwarding of arbitrary JSON number spellings.
:::

:::note[Cost model]
`String` owns UTF-8 storage. `copyBytes` allocates an independent string;
`TextBuffer` amortizes repeated construction. Dynamic JSON builds an owned tree.
Typed decoding can write fields directly without constructing an intermediate
dynamic JSON number or object graph for supported shapes.
:::

Runnable examples:
[strings](https://github.com/popaprozac/z/blob/main/examples/language/basics/strings.zs)
and [typed JSON](https://github.com/popaprozac/z/blob/main/examples/language/data/json.zs).

Next: [Async and structured concurrency](/language-tour/async-and-structured-concurrency/).
