# C Export Design

Status: first scalar Stage-0 compiler and project-artifact slice implemented.

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

`c` is contextual after `export`; it does not reserve ordinary bindings named
`c`. The source function name is initially the exact public C symbol. C APIs
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

## First ABI tier

The first executable slice accepts only types with an unambiguous scalar C ABI:

| Z | Generated C |
| --- | --- |
| `i8`, `i16`, `i32`, `i64` | `int8_t`, `int16_t`, `int32_t`, `int64_t` |
| `u8`, `u16`, `u32`, `u64` | `uint8_t`, `uint16_t`, `uint32_t`, `uint64_t` |
| `isize`, `usize` | `intptr_t`, `uintptr_t` |
| `f32`, `f64` | `float`, `double` |
| `boolean` | `bool` |
| `void` | `void` |

Tier one rejects strings, collections, slices, nullable values, structs,
classes, enums, closures, generic functions, typed errors, async functions,
and executor-affine functions at the export declaration. A targeted diagnostic
must name the unsupported boundary type or effect rather than letting generated
C fail.

The initial proof uses ordinary by-value scalar parameters. Mapping `in`,
`inout`, and `out` onto a public pointer ABI is an explicit follow-up design
decision; the compiler must not silently reinterpret those capabilities.

This narrow start is deliberate. Z-owned values must never escape through an
accidental layout, and a C caller cannot be assumed to understand Z cleanup,
ARC, task, or error representations.

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

Library output is project configuration rather than declaration syntax:

```json
{
  "target": {
    "kind": "static-library",
    "name": "zmath",
    "entry": "src/library.zs"
  }
}
```

Build the project from the repository root or from inside its directory:

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
A library entry is an export-only module graph and does not require
`function main()`.

See [`examples/interop/c/z-export`](../examples/interop/c/z-export) for a
complete Z library and handwritten strict-C consumer.

An inspectable project-level `z emit` form remains to be designed. A later
`shared-library` target kind will produce the platform dynamic-library spelling
plus the same public header. Executables remain the default target kind.

## Growth path

Broader exports should land only with an end-to-end C consumer:

1. ABI-stable scalar functions and static-library/header output.
2. Explicit C-layout structs and payload-free enums.
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

The first implementation checkpoint is complete only when a handwritten C
program includes the generated header, links the generated static library,
calls a Z scalar function, and passes strict compilation and execution tests.

The bootstrap compiler now satisfies that executable boundary in both its test
suite and the readable example: it parses and checks `export c function`, keeps
the declaration available through ordinary Z imports and calls, emits a private
implementation plus exact public C symbol, generates the guarded header,
archives the emitted object through `z build`, and runs a handwritten strict-C
consumer. The accepted `static-library` manifest fields make `main` optional
and select the public artifact name and directory.

The native semantic graph carries the C-export fact and checks it during hybrid
parity. Native lowering emits the same private-implementation/public-wrapper
shape and guarded header, and the standalone fixed-point `z` accepts the same
project-library command:

```sh
.z-cache/bootstrap/z build path/to/project
```

The native archive and header pass the same handwritten C consumer unchanged.
Broader ABI tiers and the remaining bootstrap-distribution work are independent
follow-ups rather than hidden dependencies of scalar Z-to-C use.
