# Z raylib

This application imports raylib directly from `raylib.h` and renders a small
interactive window with a hoverable quit button. It exercises:

- direct C function, record, and enum import;
- construction of native `Color` and `Rectangle` values;
- native structs returned by value;
- checked move-only `Image` and aliased `Texture2D` resource records;
- reverse-order implicit `UnloadTexture` → `UnloadImage` cleanup;
- a non-escaping borrowed texture owned by raylib's global runtime;
- explicit nominal-enum conversion with `i32(raylib.MOUSE_BUTTON_LEFT)`; and
- deterministic global-runtime cleanup through Z `deinit`.

The adjacent `raylib.h.zd` adds facts the C header cannot express: `Image` and
the canonical `Texture` record are move-only resources, their cleanup
functions, and which producers return owned versus borrowed values. The
generated call ABI remains the native C ABI—there is no wrapper allocation.
`Texture2D` and `TextureCubemap` inherit the canonical `Texture` facts even
though raylib uses only those aliases in function signatures.

The borrowed result of `GetShapesTexture()` is deliberately non-escaping in
this first tier. It may be inspected locally and passed to contracted `in`
parameters, but not stored in a Z struct, collection, enum, closure, or return
value until `.zd` can name its runtime lifetime. `RaylibRuntime` ensures
`CloseWindow()` runs only after the owned texture and image are released.

On macOS, install raylib with Homebrew and run from the repository root:

```sh
brew install raylib
bun run z run examples/applications/z-raylib/main.zs
```

The source uses the portable header spelling `"raylib.h"` rather than embedding
one machine's Homebrew prefix. `z.json` supplies the Apple Silicon Homebrew
search paths to both the compiler and language server, so direct `z check`,
hover, and completion see the same header. Change those paths to
`/usr/local/include` and `/usr/local/lib` for an Intel Homebrew installation.
