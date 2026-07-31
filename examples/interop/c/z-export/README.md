# Calling Z from C

`library.zs` exports ordinary Z functions through an explicit stable C ABI and
passes a checked `c struct` and fixed-representation `c enum` by value.
Exported functions remain callable and importable from Z. The C-layout types
keep ordinary Z value and exhaustive-match semantics while guaranteeing the
representation printed in the generated header.

The handwritten C host initializes the generated `zmath` runtime, calls the Z
exports, and shuts the runtime down. The adjacent `z-runtime-export` example
adds host-created pthread entry and deterministic busy-shutdown pressure.

From the repository root, build the manifest-selected static-library target:

```sh
bun run z build examples/interop/c/z-export

clang -std=c11 -Wall -Wextra -Werror \
  -I examples/interop/c/z-export/build \
  examples/interop/c/z-export/consumer.c \
  examples/interop/c/z-export/build/libzmath.a \
  -o examples/interop/c/z-export/build/consumer

examples/interop/c/z-export/build/consumer
```

The bootstrapped native compiler provides the same project command:

```sh
bun run bootstrap
cd examples/interop/c/z-export
../../../../.z-cache/bootstrap/z build .
```

Expected output:

```text
sum=42 answer=42 even=true point=(21,22) status=1
```

The project build publishes:

```text
build/libzmath.a
build/zmath.h
```

Compiler-owned C and object files remain under `.z-cache/build`.
