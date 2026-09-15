# Borrowed bytes from C

This library accepts arbitrary bytes through `Slice<u8>` parameters. The
generated C header uses `const uint8_t *` plus `uintptr_t` length for each slice;
it does not publish Z's private slice layout. Embedded NUL and invalid UTF-8
are preserved without scanning or copying the input.

From the repository root:

```sh
bun run z build examples/interop/c/z-bytes-export --release
clang -std=c11 -Wall -Wextra -Werror \
  -I examples/interop/c/z-bytes-export/build \
  examples/interop/c/z-bytes-export/consumer.c \
  examples/interop/c/z-bytes-export/build/libzbytes.a \
  -o /tmp/z-bytes-consumer
/tmp/z-bytes-consumer
```

Expected output:

```text
4 bytes, sum 386; empty input accepted
```

The C caller keeps the stated byte range valid and unmodified until the call
returns. `(NULL, 0)` is an empty slice; `(NULL, positive_length)` traps. Z code
cannot mutate, return, or retain the borrowed slice. Copy bytes into owned
storage during the call if they must outlive it. `Slice` is already borrowed,
so the Z parameter has no `in` prefix.

This is a synchronous input contract, not a general pointer API. Mutable
slices, returned slices, and async exports are unsupported. Use `String` only
when the host is promising NUL-terminated valid UTF-8 and an owned copy is
appropriate. See [C exports](../../../../docs/c-exports.md).
