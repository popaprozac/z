# C Export Design

Status: first scalar compiler slice implemented; project artifact command pending.

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

Library output remains project configuration rather than declaration syntax.
The intended manifest direction is:

```json
{
  "target": {
    "kind": "static-library",
    "name": "zmath",
    "entry": "src/library.zs"
  }
}
```

The first build slice should publish `libzmath.a` and `zmath.h`. `z emit`
should publish inspectable C and header source without compiling them. A later
`shared-library` kind produces the platform dynamic-library spelling plus the
same public header. Executables remain the default target kind. A library entry
is an export-only module graph and does not require `function main()`.

Exact output-directory and command-line override spelling will be reviewed
against the existing native driver during implementation; the artifact kinds
and generated-header requirement are settled.

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

The bootstrap compiler now satisfies that executable boundary in its test
suite: it parses and checks `export c function`, keeps the declaration
available through ordinary Z imports and calls, emits a private implementation
plus exact public C symbol, generates the guarded header, archives the emitted
object, and runs a handwritten strict-C consumer. The accepted
`static-library` manifest fields are also checked and make `main` optional.
The remaining first-tier packaging step is the public `z build`/`z emit`
project command and stable output-directory policy. The native frontend accepts
the contextual declaration during hybrid checking; carrying the export fact
through native lowering/header emission remains part of self-hosted backend
parity.
