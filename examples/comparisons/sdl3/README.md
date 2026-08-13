# SDL3 C-interop comparison

This directory implements the same small SDL3 application in the native
languages already used by Z's performance comparisons. The canonical Z source
is [`../../applications/z-sdl3/main.zs`](../../applications/z-sdl3/main.zs),
with its adjacent [`.zd` contracts](../../applications/z-sdl3). The other
implementations are:

- [`c/main.c`](c/main.c)
- [`zig/main.zig`](zig/main.zig)
- [`nim/main.nim`](nim/main.nim)
- [`rust/src/main.rs`](rust/src/main.rs)

Each program opens an 800 by 450 window, draws the same hoverable **QUIT**
button, exits on a click or SDL quit/window-close event, reports the closing
window ID, polls scalar mouse outputs, and destroys the renderer, window, and
SDL runtime in that order. Only the window title identifies the language.

This is a **developer-experience comparison**, not a benchmark and not a line
count contest. Formatting, local helper choices, generated bindings, and
high-level wrapper libraries can all change source size. The useful question is
where ABI discovery, ownership, union validity, initialization, and cleanup are
proved—and how much of that proof is reusable.

## Interop shape

| Language | How SDL enters the program | Cleanup and owner relationship | Event union and scalar outputs | Explicit unchecked surface |
| --- | --- | --- | --- | --- |
| Z | Imports the real headers through Clang; 69 lines of adjacent `.zd` add only facts absent from C | `.zd` marks nullable results as owned, records their destructors, and marks renderer calls as borrows; ordinary scope exit performs reverse cleanup | `.zd` describes the discriminator and active payload, so `match (in event)` is checked and allocation-free; `out` initializes event and mouse storage | None in the application |
| C | `#include <SDL3/SDL.h>` | Handwritten `goto cleanup` ladder and null checks | Direct union field and pointer writes; correctness rests on the programmer and SDL documentation | The whole program has C's ordinary unchecked authority |
| Zig | `@cImport` parses the header at compile time | Explicit `defer` calls provide concise reverse cleanup; the renderer/window lifetime relationship is conventional | Direct translated union access and `undefined` output storage | No separate unsafe marker for these pointer/union operations |
| Nim | Each used type, constant, and procedure is declared with `importc` and `header` | Explicit `defer` calls; native handle relationships are conventional | A handwritten imported union view and ordinary address-taking for outputs | No separate unsafe marker around the imported ABI operations |
| Rust | The generated `sdl3-sys` crate supplies raw bindings; Cargo obtains that additional package | Local `Drop` newtypes and `PhantomData` encode cleanup and renderer-before-window lifetime | `MaybeUninit` models native outputs; reading union members and all raw calls require `unsafe` | Every raw FFI call, union read, and initialization assertion is visibly unsafe |

The Rust example intentionally uses `sdl3-sys`, not the high-level `sdl3`
crate. A mature wrapper crate can provide a much smaller safe application, but
that compares wrapper-library coverage rather than each language's direct C
interop. The local Rust wrappers show what is required to turn the raw generated
surface into the ownership guarantees expressed by Z's reusable `.zd` facts.

Zig and Z both derive declarations from the header. Their key difference in
this example is not call overhead—both call SDL directly—but where safety facts
live. Zig keeps cleanup and union interpretation in application source. Z keeps
ABI declarations in the header and adds semantic facts once in `.zd`, allowing
the ordinary application to use nullable ownership, `out`, and exhaustive
native-union matching without an unsafe block or wrapper allocation.

Nim supports excellent C-family interop, but its `importc` model names the
surface being used. Tools such as `c2nim` or third-party SDL bindings can
generate or package that work; this example keeps the declarations visible so
the comparison does not mistake generated glue for compiler-understood header
semantics.

## Source footprint

The current checked-in sources provide context, not a score:

| Language | Application source | Additional checked-in interop/configuration |
| --- | ---: | ---: |
| Z | 101 lines | 90 `.zd` lines plus 13 `z.json` lines |
| C | 98 lines | None |
| Zig | 81 lines | None; include/link flags are supplied to the compiler |
| Nim | 129 lines | The minimal imported SDL surface is included in that file |
| Rust | 161 lines | 8-line `Cargo.toml`, 8-line `build.rs`, plus generated `sdl3-sys` bindings outside this repository |

The Z contract is intentionally counted: it is real work and part of the DX.
Its benefit is that it is checked against the header, shared by every Z module
using that native module, powers diagnostics/editor information, and removes
the same ownership and union proof from each call site.

## Build and run on Apple Silicon macOS

Install SDL3 first:

```sh
brew install sdl3
```

Run Z from the repository root:

```sh
bun run z run examples/applications/z-sdl3
```

Build and run C:

```sh
clang examples/comparisons/sdl3/c/main.c \
  -I/opt/homebrew/include -L/opt/homebrew/lib -lSDL3 \
  -o /tmp/z-sdl3-c
/tmp/z-sdl3-c
```

Build and run Zig:

```sh
zig build-exe examples/comparisons/sdl3/zig/main.zig \
  -I /opt/homebrew/include -L /opt/homebrew/lib -lSDL3 -lc \
  -femit-bin=/tmp/z-sdl3-zig
/tmp/z-sdl3-zig
```

Build and run Nim:

```sh
nim c -r --out:/tmp/z-sdl3-nim \
  --passC:-I/opt/homebrew/include \
  --passL:-L/opt/homebrew/lib --passL:-lSDL3 \
  examples/comparisons/sdl3/nim/main.nim
```

Build and run Rust:

```sh
cargo run \
  --manifest-path examples/comparisons/sdl3/rust/Cargo.toml \
  --target-dir /tmp/z-sdl3-rust-target
```

The Rust `build.rs` defaults to `/opt/homebrew/lib`; set `SDL3_LIB_DIR` for a
different installation. For Intel Homebrew, replace `/opt/homebrew` in the
other commands and Z's `z.json` with `/usr/local`.

These commands are deliberately visible instead of hidden behind one script:
compiler flags, package acquisition, generated bindings, and link discovery are
part of the interop experience being compared.
