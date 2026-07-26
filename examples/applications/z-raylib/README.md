# Z raylib

This application imports raylib directly from `raylib.h` and renders a small
interactive window with a hoverable quit button. It exercises:

- direct C function, record, and enum import;
- construction of native `Color` and `Rectangle` values;
- native structs returned by value;
- explicit nominal-enum conversion with `i32(raylib.MOUSE_BUTTON_LEFT)`; and
- deterministic global-runtime cleanup through Z `deinit`.

The checked Z surface needs no `.zd` additions because this deliberately narrow
slice uses only plain C values and functions. That is not yet evidence that all
of raylib is representable: APIs that pass pointer-bearing resource records
such as `Image`, `Shader`, and `Model` by value remain outside Z's checked
foreign-value tier. Z now diagnoses that boundary directly and recommends
`raw c` for a one-off operation; a reviewed `.zd` value-resource contract is
the intended reusable solution. `RaylibRuntime` ensures `CloseWindow()` runs on
every exit after successful initialization.

On macOS, install raylib with Homebrew and run from the repository root:

```sh
brew install raylib
examples/applications/z-raylib/run.sh
```

The source uses the portable header spelling `"raylib.h"` rather than embedding
one machine's Homebrew prefix. `z.json` supplies the Apple Silicon Homebrew
search paths to both the compiler and language server, so direct `z check`,
hover, and completion see the same header. Change those paths to
`/usr/local/include` and `/usr/local/lib` for an Intel Homebrew installation.
