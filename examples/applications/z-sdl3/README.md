# Z SDL3

This application imports SDL3 headers directly and renders a small interactive
window with a hoverable quit button. It exercises:

- a large real-world header whose Clang AST exceeds 64 MiB;
- directly imported C functions, constants, and nominal enums;
- explicit enum-to-integer conversion for SDL event queries;
- nullable owned `SDL_Window*` and `SDL_Renderer*` values with `.zd` cleanup;
- inferred `f32` storage initialized through checked scalar `out` pointers; and
- deterministic reverse-order cleanup through Z ownership and `deinit`.

The adjacent declarations add only facts absent from the headers. Window and
renderer constructors receive ownership and cleanup contracts, renderer calls
borrow their owner, and `SDL_GetMouseState` declares that its two `float*`
parameters initialize one scalar each.

`SDLRuntime` calls `SDL_Quit()` last. On every exit after initialization, Z
first destroys the renderer, then the window, then the runtime guard.

The current loop is intentionally a temporary event probe. It pumps SDL and
queries quit-event presence with `SDL_HasEvent`, but it does not dequeue
ordinary events. The conventional `SDL_PollEvent(out event)` loop is blocked
because `SDL_Event` is an ABI union and the current importer exposes its scalar
`type` discriminator while withholding nested record and pointer payload
members. This example therefore proves the checked window, renderer, scalar
output, enum-conversion, and cleanup paths—not complete SDL event handling.

On macOS, install SDL3 with Homebrew and run from the repository root:

```sh
brew install sdl3
examples/applications/z-sdl3/run.sh
```

`z.json` supplies the Apple Silicon Homebrew header and library directories to
both the compiler and language server. Change them to `/usr/local/include` and
`/usr/local/lib` for an Intel Homebrew installation.
