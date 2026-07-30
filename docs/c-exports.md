# C Export Design

Status: scalar functions, checked by-value C-layout structs, and
fixed-representation C enums implemented in both the Stage-0 and fixed-point
native compilers.

This note defines the first direction for calling Z from C-family consumers.
It complements header-first native imports: importing a header brings native
code into Z, while a C export publishes a checked Z implementation through a
stable native ABI.

## Source boundary

An ordinary export is visible to other Z modules:

```z
export function add(left: i32, right: i32): i32 {
  return left + right;
}
```

A C export additionally publishes a C ABI symbol:

```z
export c function z_math_add(left: i32, right: i32): i32 {
  return left + right;
}
```

`c` is contextual at a native ABI declaration; it does not reserve ordinary
bindings named `c`. The source function name is initially the exact public C symbol. C APIs
normally prefix global symbols, and requiring that spelling keeps the first
tier explicit without adding ABI-alias grammar prematurely. A project that
wants a different internal name can use a boundary wrapper:

```z
function add(left: i32, right: i32): i32 {
  return left + right;
}

export c function z_math_add(left: i32, right: i32): i32 {
  return add(left, right);
}
```

Two C exports with the same symbol are an error across the complete linked
module graph. They are not silently module-mangled because their names are an
external ABI contract.

`export c function` is preferred over:

- treating every Z module export as a native symbol;
- `extern`, which conventionally describes an implementation supplied
  elsewhere;
- comments or decorators that sit outside ordinary semantic checking;
- a manifest list separated from the declaration it exposes; or
- `as c`, because TypeScript-shaped `as` does not perform conversion or create
  linkage.

## Scalar ABI tier

The first executable slice accepts only types with an unambiguous scalar C ABI:

| Z | Generated C |
| --- | --- |
| `i8`, `i16`, `i32`, `i64` | `int8_t`, `int16_t`, `int32_t`, `int64_t` |
| `u8`, `u16`, `u32`, `u64` | `uint8_t`, `uint16_t`, `uint32_t`, `uint64_t` |
| `isize`, `usize` | `intptr_t`, `uintptr_t` |
| `f32`, `f64` | `float`, `double` |
| `boolean` | `bool` |
| `void` | `void` |

The boundary still rejects strings, collections, slices, nullable values,
ordinary Z structs and enums, classes, closures, generic functions, typed
errors, async functions, and executor-affine functions. Checked `c struct` and
`c enum` values are the deliberate exceptions described below. A targeted
diagnostic must name the unsupported boundary type or effect rather than
letting generated C fail.

The initial proof uses ordinary by-value scalar parameters. Mapping `in`,
`inout`, and `out` onto a public pointer ABI is an explicit follow-up design
decision; the compiler must not silently reinterpret those capabilities.

This narrow start is deliberate. Z-owned values must never escape through an
accidental layout, and a C caller cannot be assumed to understand Z cleanup,
ARC, task, or error representations.

## C-layout structs

`c struct` is a representation contract independent from ordinary Z module
visibility:

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

The generated header contains the reachable value type and exact public
function signature:

```c
typedef struct ZMathPoint {
  int32_t x;
  int32_t y;
} ZMathPoint;

Z_API ZMathPoint z_math_translate(
  ZMathPoint point,
  int32_t dx,
  int32_t dy
);
```

`export c struct` composes ordinary Z module export with the same C layout
contract. Header generation follows reachability from C-exported function
signatures, so an internal `c struct` can still define a public function's ABI
without becoming a general Z module export.

The first struct tier permits public mutable fields containing fixed-width
scalars or other `c struct` values. It rejects empty and generic structs,
classes, private or readonly fields, traits, executor affinity, constructors,
and `deinit`. These restrictions prevent the C representation from bypassing
an invariant or cleanup obligation that the header cannot express. Methods do
not affect layout and remain Z-only.

## Fixed-representation C enums

`c enum` keeps Z's nominal enum and exhaustive-match semantics while fixing its
public scalar representation:

```z
c enum ZMathStatus: i32 {
  negative,
  zero,
  positive,
}

export c function z_math_classify(value: i32): ZMathStatus {
  if (value < 0) return ZMathStatus.negative;
  if (value == 0) return ZMathStatus.zero;
  return ZMathStatus.positive;
}

export c function z_math_status_code(status: ZMathStatus): i32 {
  return match (status) {
    negative => -1;
    zero => 0;
    positive => 1;
  };
}
```

The generated header uses the declared fixed-width integer and sequential
constants:

```c
typedef int32_t ZMathStatus;
#define ZMathStatus_negative ((ZMathStatus)0)
#define ZMathStatus_zero ((ZMathStatus)1)
#define ZMathStatus_positive ((ZMathStatus)2)
```

The first tier requires an integer representation, at least one payload-free
variant, and valid C identifiers. Explicit discriminants are a later extension.
A C caller can manufacture any integer, so every exported function accepting a
`c enum` validates the input before it enters ordinary safe Z. An unknown value
traps at that boundary rather than making an exhaustive Z match unsound.

## Generated interface

The backend keeps Z's implementation identity private and emits a public
wrapper:

```c
static int32_t Z_internal_z_math_add(int32_t left, int32_t right) {
    return left + right;
}

Z_API int32_t z_math_add(int32_t left, int32_t right) {
    return Z_internal_z_math_add(left, right);
}
```

The wrapper separates the permanent public ABI from compiler-owned internal
names and calling conventions. Release-code inspection must verify that Clang
inlines a trivial internal call when its semantics permit it.

Z also emits a header:

```c
#pragma once
#include <stdbool.h>
#include <stdint.h>

#ifndef Z_API
#define Z_API
#endif

#if defined(__cplusplus)
extern "C" {
#endif

Z_API int32_t z_math_add(int32_t left, int32_t right);

#if defined(__cplusplus)
}
#endif
```

`Z_API` expands to the target's required import/export visibility. The
`extern "C"` guard makes the same artifact directly consumable by C++ and
Objective-C++; ordinary C importing also makes the first tier available to
Swift without implementing the Swift ABI.

## Artifacts

Library output is project configuration rather than declaration syntax. Static
and shared libraries use the same source-level ABI contract:

```json
{
  "target": {
    "kind": "static-library",
    "name": "zmath",
    "entry": "src/library.zs"
  }
}
```

With `z` on `PATH`, build from the project directory:

```sh
cd path/to/project
z build .
z build . --release
```

The repository Stage-0 wrapper runs from the package root, so its equivalent is:

```sh
bun run z build path/to/project
bun run z build path/to/project --release
```

The first command produces a debuggable library. `--release` selects optimized
code. The public artifacts are:

```text
build/libzmath.a
build/zmath.h
```

On Windows the archive uses `zmath.lib`. Compiler-owned generated source and
object files remain under `.z-cache/build`; consumers do not need them.
Static- and shared-library entries are export-only module graphs and do not
require `function main()`. All manifest targets require `target.name` and
`target.entry`; omitting `target.kind` selects an executable instead. Project
`check` accepts every target kind, while project `run` requires an executable.

See [`examples/interop/c/z-export`](../examples/interop/c/z-export) for a
complete Z library and handwritten strict-C consumer.

Changing the target kind to `"shared-library"` publishes the same header beside
the host-native dynamic artifact:

| Host | Shared artifact |
| --- | --- |
| macOS | `build/lib<name>.dylib` |
| Linux | `build/lib<name>.so` |
| Windows | `build/<name>.dll` |

[`examples/interop/c/z-shared-export`](../examples/interop/c/z-shared-export)
builds and runs the dynamic form. Versioned sonames/install names, installation
layout, and Windows import-library publication remain packaging work. An
inspectable project-level `z emit` form also remains to be designed; source
emission still selects an explicit `.zs` file. Executables remain the default
target kind.

## Growth path

Broader exports should land only with an end-to-end C consumer:

1. ABI-stable scalar functions and static/shared-library header output.
2. Explicit C-layout structs and fixed-representation payload-free enums.
3. Borrowed strings and slices projected as pointer-plus-length inputs.
4. Typed `throws` projected into explicit status and output channels.
5. Owned results paired with generated destruction functions.
6. Callback exports with explicit context, ownership, and threading.
7. Async exports through completion callbacks or explicit task handles.

For binary-only Z consumption, the toolchain can eventually generate an
adjacent `.zd` beside the public header. The header remains ABI truth; the
generated declaration preserves ownership and error facts that C cannot encode:

```text
Z source
  ├─> generated header and library ─> C, C++, Objective-C, Swift
  └─> generated adjacent .zd       ─> checked binary-only Z import
```

The current value-ABI checkpoint is complete only when handwritten C programs
include the generated header, link the generated static and shared libraries,
pass supported values in both directions, and pass strict compilation and
execution tests.

The bootstrap compiler now satisfies that executable boundary in both its test
suite and the readable example: it parses and checks `export c function`, keeps
the declaration available through ordinary Z imports and calls, emits a private
implementation plus exact public C symbol, generates the guarded header,
builds the selected library artifact through `z build`, and runs handwritten
strict-C consumers. The accepted `static-library` and `shared-library` manifest
kinds make `main` optional and select the public artifact form.

The native semantic graph carries the C-export fact and checks it during hybrid
parity. Native lowering emits the same private-implementation/public-wrapper
shape and guarded header, and the standalone fixed-point `z` accepts the same
project-library command:

```sh
cd examples/interop/c/z-export
../../../../.z-cache/bootstrap/z build .
```

The native archive and header pass the same handwritten C consumer unchanged,
including struct construction, enum constants, and an enum parameter validated
by the public wrapper. Broader ABI tiers and the remaining
bootstrap-distribution work are independent follow-ups rather than hidden
dependencies of value-oriented Z-to-C use.
