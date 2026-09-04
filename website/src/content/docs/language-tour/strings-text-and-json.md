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
  const user = try json.decode<User>(source);
  const encoded = json.encode(in user);
  return user;
}
```

Integers decode directly into the requested width, so a `u64` ID does not pass
through an imprecise `f64`. Missing fields with defaults evaluate those
defaults; other missing fields fail. Unknown fields are skipped recursively,
duplicate known fields are rejected, and encoding follows declaration order.

:::caution[Current typed-codec boundary]
The derived encoder supports public, non-optional `String`, `boolean`, signed
or unsigned integer, and `Array<String>` fields in ordinary value structs. The
decoder also accepts nested value structs and `Array<Struct>` fields, including
recursive trees through arrays. Stage 0 and the fixed-point compiler emit
direct streaming codecs without an intermediate dynamic tree. Optional values,
floating point, other collections, classes, custom constructors, custom
field-name policies, and encoding nested typed aggregates remain later tiers.
Dynamic `json.parse` and `json.stringify` cover broader JSON shapes today.
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
