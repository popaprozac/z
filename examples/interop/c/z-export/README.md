# Calling Z from C

`library.zs` exports ordinary Z functions through an explicit stable C ABI and
passes a checked `c struct` by value. Exported functions remain callable and
importable from Z. The `c struct` keeps ordinary Z value semantics while
guaranteeing the field order and target C ABI layout printed in the header.

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

The bootstrapped native compiler provides the same project command:

```sh
bun run bootstrap
.z-cache/bootstrap/z build examples/interop/c/z-export
```

Expected output:

```text
sum=42 answer=42 even=true point=(21,22)
```

The project build publishes:

```text
build/libzmath.a
build/zmath.h
```

Compiler-owned C and object files remain under `.z-cache/build`.
