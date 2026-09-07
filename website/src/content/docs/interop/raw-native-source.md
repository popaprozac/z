---
title: Raw native source
description: Isolate C, C++, or Objective-C source behind an explicit typed boundary when Z cannot represent the operation.
sidebar:
  order: 5
---

`raw` is the final interop escape hatch. Inside the body you are writing the
selected native language, not unchecked Z.

```z
const observed = raw c
  using (in left, inout right, out output)
  : i32 {
    *right += *left;
    *output = *right;
    return *output;
  };
```

The compiler lowers this expression to an isolated helper. The `using` clause
is the complete audited boundary between surrounding Z storage and the native
body.

## Boundary capabilities

| Capture | Native permission |
| --- | --- |
| `in value` | Read the borrowed input |
| `inout value` | Read and replace caller storage |
| `out value` | Initialize previously uninitialized caller storage |

Every lexical Z value used by the body must appear in `using`. `out` must be
initialized on every successful helper path, and its binding becomes readable
after the raw expression completes.

The first tier accepts ABI-stable scalars, `cstring`, and imported native types.
It rejects `move` captures and Z-owned representations whose native lifetime
cannot be described by this small helper boundary.

## Native `return` stays local

The helper is an important semantic boundary:

```z
function calculate(left: i32, right: i32): i32 {
  const answer = raw c using (in left, in right): i32 {
    return *left + *right;
  };

  return answer;
}
```

The first `return` exits the generated C helper. It cannot skip Z cleanup or
return from `calculate`. Surrounding owners remain under ordinary Z lifetime
rules.

## Give a whole function a native body

When the function signature already describes the complete boundary, use a raw
function body:

```z
function add(left: i32, right: i32): i32 = raw c {
  return left + right;
}

function nativeCount(input: i32): i32 = raw cpp {
  return static_cast<int32_t>(input);
}
```

Objective-C bodies use the same form and may retain an explicit main-executor
contract:

```z
function activateNative(): i32 on thread.main = raw objc {
  // Objective-C source
  return 0;
}
```

The supported tags are `c`, `cpp`, and `objc`. Async, throwing, generic, and
method raw bodies remain outside the current tier.

For an `in` Objective-C reference, the native parameter is the object pointer,
not a pointer to its ARC storage slot. This remains true for a stored-reference
argument such as `in resource.file` or `in this.file` during `deinit`. Scalar
and value borrows still pass storage addresses. This fixes a representation
boundary; it does not allow arbitrary native property projections or change Z
class aliasing rules.

Owned Z structs containing Objective-C references also compose with `Option`
and throwing results. Both compiler paths choose ARC-compatible payload
storage: nested strong-reference payloads use separate slots rather than an
illegal C union. This requires no heap box, though an enum with multiple such
payload alternatives can be larger than a union.

Stage 0 and the fixed-point native compiler preserve the body verbatim, map
native diagnostics back to this `.zs` location, and include native headers
explicitly imported by the containing module. A header remains available even
when the raw body is its only consumer.

The Z editor extension embeds the platform C, C++, or Objective-C TextMate
grammar inside both named and anonymous raw bodies. Nested native braces remain
inside the embedded language, while Z semantic tokens stop at the raw-source
boundary. Native completion, hover, and go-to-definition are a later
Clang-backed editor tier; highlighting does not imply that Z has type-checked
the body.

## What raw source can see

The generated translation unit already includes imported headers. Their
functions, constants, macros, records, unions, and native language features are
available to the appropriate compiler even when Z cannot model them.

The raw body cannot reference compiler-generated private symbols. Legitimate
header names—including libraries whose public constants begin with `Z_`—remain
valid; the compiler rejects actual generated-name collisions rather than
claiming a broad vendor prefix.

Native diagnostics are mapped back to the original `.zs` location. This is
essential: the generated translation unit is an implementation artifact, not
the source developers should debug.

## Choosing between the tiers

| Need | Use |
| --- | --- |
| A supported header declaration | Direct import |
| Reusable ownership, cleanup, callback, error, or lifetime facts | `.zd` |
| One local typed interpretation of a native value | `unsafe` |
| Native syntax or a type-system escape | `raw c/cpp/objc` |

Raw source should remain visibly less convenient than the checked path. If a
pattern recurs, it is evidence that the importer or `.zd` vocabulary should
grow.

:::note[Cost model]
An anonymous raw expression lowers to one helper call, which an optimizing
native compiler may inline when legal. A whole raw function is already the
declared operation. Z adds no reflection or dynamic dispatch, but it also makes
no safety claim about operations inside the native body.
:::

Runnable example:
[raw native boundary](https://github.com/popaprozac/z/blob/main/examples/interop/raw/native-boundary.zs).

Next: [Objective-C interop](/interop/objective-c/).
