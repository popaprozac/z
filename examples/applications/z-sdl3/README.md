# Z SDL3

This application imports SDL3 headers directly and renders a small interactive
window with a hoverable quit button. It exercises:

- a large real-world header whose Clang AST exceeds 64 MiB;
- directly imported C functions, constants, and nominal enums;
- opaque `SDL_Event` union storage initialized through checked `out`;
- checked `.zd` discrimination of selected native union variants;
- borrowed, allocation-free `match (in event)` payload projection;
- nullable owned `SDL_Window*` and `SDL_Renderer*` values with `.zd` cleanup;
- inferred `f32` storage initialized through checked scalar `out` pointers; and
- deterministic reverse-order cleanup through Z ownership and `deinit`.

The adjacent declarations add only facts absent from the headers. Window and
renderer constructors receive ownership and cleanup contracts, renderer calls
borrow their owner, and `SDL_GetMouseState` declares that its two `float*`
parameters initialize one scalar each.

`SDLRuntime` calls `SDL_Quit()` last. On every exit after initialization, Z
first destroys the renderer, then the window, then the runtime guard.

The event loop uses the conventional `SDL_PollEvent(out event)` shape. Its
adjacent declaration identifies the `type` discriminator, maps the quit and
window-close tags, and names the active `window` member. Z then lowers
`match (in event)` directly to a C `switch`; `windowEvent` is a non-escaping
view into the native union, with no wrapper allocation or payload copy. The
`other(type)` fallback preserves SDL's open-ended event space. Arbitrary or
pointer-bearing union members remain unavailable in safe Z until contracted.

On macOS, install SDL3 with Homebrew and run the project target:

```sh
brew install sdl3
bun run z run examples/applications/z-sdl3
```

`z.json` supplies the Apple Silicon Homebrew header and library directories to
both the compiler and language server. Change them to `/usr/local/include` and
`/usr/local/lib` for an Intel Homebrew installation.
