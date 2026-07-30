# Calling a shared Z library from C

This project uses the same checked `export c` boundary as the static-library
example while selecting a dynamically linked artifact in `z.json`:

```json
{
  "target": {
    "kind": "shared-library",
    "name": "zshared",
    "entry": "library.zs"
  }
}
```

Build it from the repository root:

```sh
bun run z build examples/interop/c/z-shared-export --release
```

On macOS, compile and run the handwritten consumer with:

```sh
clang -std=c11 -Wall -Wextra -Werror \
  -I examples/interop/c/z-shared-export/build \
  examples/interop/c/z-shared-export/consumer.c \
  examples/interop/c/z-shared-export/build/libzshared.dylib \
  -Wl,-rpath,"$PWD/examples/interop/c/z-shared-export/build" \
  -o examples/interop/c/z-shared-export/build/consumer

examples/interop/c/z-shared-export/build/consumer
```

Expected output:

```text
shared=42
```

The project publishes `zshared.h` plus the host-native shared artifact:

| Host | Artifact |
| --- | --- |
| macOS | `libzshared.dylib` |
| Linux | `libzshared.so` |
| Windows | `zshared.dll` |

Versioned sonames, installation layout, and Windows import-library policy are
future packaging layers rather than implicit behavior in this first target.
