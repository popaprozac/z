---
title: Exporting Z through C
description: Publish checked Z functions and value types through a generated stable C ABI for embedding and foreign consumers.
sidebar:
  order: 9
---

Interop works in both directions. `export c function` keeps a function callable
from Z while additionally publishing a stable C symbol:

```z
function double(value: i32): i32 {
  return value * 2;
}

export c function z_math_add(left: i32, right: i32): i32 {
  return left + right;
}

export c function z_math_answer(): i32 {
  return z_math_add(double(10), 22);
}
```

The C name is exact and intentionally explicit. Ordinary Z callers invoke the
Z implementation directly; they do not cross the generated foreign wrapper.

## Supported scalar ABI

| Z | Generated C |
| --- | --- |
| `i8`…`i64` | `int8_t`…`int64_t` |
| `u8`…`u64` | `uint8_t`…`uint64_t` |
| `isize`, `usize` | `intptr_t`, `uintptr_t` |
| `f32`, `f64` | `float`, `double` |
| `boolean` | `bool` |
| `void` | `void` |

An owned Z `String` input projects as borrowed `const char *` at the C ABI:

```z
export c function z_text_byte_length(text: String): usize {
  return text.byteLength;
}
```

The wrapper validates non-null NUL-terminated UTF-8, copies it once into owned
Z storage, and runs ordinary Z cleanup on every path. Z-to-Z calls pass the
`String` directly and make no boundary copy. Returning an owned `String` to C
remains unsupported until the public ABI can state allocator and release rules.

## Publish C-layout values deliberately

Ordinary Z structs do not silently become public native layouts. Mark the
representation explicitly:

```z
c struct ZMathPoint {
  x: i32;
  y: i32;
}

export c function z_math_translate(
  point: ZMathPoint,
  dx: i32,
  dy: i32
): ZMathPoint {
  return ZMathPoint({
    x: point.x + dx,
    y: point.y + dy,
  });
}
```

Fixed-representation enums retain nominal Z matching while publishing an exact
integer representation:

```z
c enum ZMathStatus: i32 {
  negative,
  zero,
  positive,
}
```

The wrapper validates enum inputs from C before they enter safe Z, because a C
caller can manufacture an integer outside the declared variants.

The first `c struct` tier accepts public mutable scalar or nested C-layout
fields and rejects cleanup-bearing, generic, private, readonly, class, or
executor-affine layouts that a plain C header could not preserve safely.

## Build a static or shared library

Project configuration chooses the artifact independently from source ABI:

```json
{
  "target": {
    "kind": "static-library",
    "name": "zmath",
    "entry": "library.zs"
  }
}
```

```sh
z build . --release
```

The static project publishes:

```text
build/libzmath.a
build/zmath.h
```

Use `"shared-library"` to publish a `.dylib`, `.so`, or `.dll` plus the same
checked header contract. Executables remain the default when `kind` is omitted.

## Generated runtime lifecycle

The public header includes target-scoped initialization and shutdown functions.
A native host initializes before its first exported call and shuts down only
after exported calls, native workers, and registered callbacks have drained.

Every public wrapper enters and leaves the bounded Z runtime. This makes
foreign-created threads, ARC state, callbacks, and future runtime-owned roots
safe without charging ordinary Z-to-Z calls for foreign-boundary accounting.

A project may configure one cleanup-bearing runtime root:

```json
{
  "target": {
    "kind": "static-library",
    "name": "application_core",
    "entry": "library.zs",
    "runtime": {
      "initialize": "initializeRuntime"
    }
  }
}
```

The initializer's owner remains alive until host shutdown, providing a natural
home for application identity, `Once<T>`, callback registrations, and other
embedding-lifetime resources.

## Why the generated wrapper exists

The compiler keeps internal Z symbols private and places the stable ABI in a
small public wrapper. That wrapper is where it can:

- validate hostile C inputs;
- create owned Z values from foreign representations;
- enter and leave the embedded runtime;
- preserve future compiler freedom over internal names and calling conventions.

The generated header includes an `extern "C"` guard, so the same library is
directly consumable from C++, Objective-C++, and Swift's C importer.

:::caution[Current boundary]
Collections, slices, nullable values, classes, closures, generic functions,
typed errors, async functions, executor-affine functions, and owned result
strings do not yet have a stable public C representation. Z rejects them with a
source diagnostic rather than leaking an internal layout.
:::

:::note[Cost model]
Foreign calls pay one public wrapper plus bounded runtime entry/leave and any
explicit conversion such as a UTF-8 copy. Ordinary Z calls to the same exported
function target its internal implementation directly. Release inspection checks
whether Clang removes wrapper-internal call overhead where semantics permit.
:::

Runnable examples:
[static library](https://github.com/popaprozac/z/tree/main/examples/interop/c/z-export),
[shared library](https://github.com/popaprozac/z/tree/main/examples/interop/c/z-shared-export),
and [embedded runtime root](https://github.com/popaprozac/z/tree/main/examples/interop/c/z-runtime-export).

Continue with the [reference map](/reference/) for exact ABI restrictions and
embedding lifecycle details.
