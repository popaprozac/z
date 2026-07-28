# Calling Z from C

`library.zs` exports ordinary Z functions through an explicit stable C ABI.
Those functions remain callable and importable from Z; `c` adds the generated
native entry point and header declaration.

From the repository root:

```sh
bun run z build examples/interop/c/z-export

clang -std=c11 -Wall -Wextra -Werror \
  -I examples/interop/c/z-export/build \
  examples/interop/c/z-export/consumer.c \
  examples/interop/c/z-export/build/libzmath.a \
  -o examples/interop/c/z-export/build/consumer

examples/interop/c/z-export/build/consumer
```

Expected output:

```text
sum=42 answer=42 even=true
```

The project build publishes:

```text
build/libzmath.a
build/zmath.h
```

Compiler-owned C and object files remain under `.z-cache/build`.
