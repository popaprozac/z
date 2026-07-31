# Embedding the Z runtime

This static-library example isolates the lifecycle contract generated for a Z
library. The handwritten C host:

1. initializes `zembed`;
2. enters a Z export from a pthread worker;
3. proves shutdown reports `ZEMBED_RUNTIME_BUSY` while that call is live;
4. releases and joins the worker; and
5. shuts Z down deterministically.

The two functions in `runtime-host.h` are a test gate implemented by the C
host, not runtime shims. They keep one exported call live long enough to make
the shutdown race deterministic.

From the repository root:

```sh
bun run z build examples/interop/c/z-runtime-export

clang -std=c11 -Wall -Wextra -Werror -pthread \
  -I examples/interop/c/z-runtime-export \
  -I examples/interop/c/z-runtime-export/build \
  examples/interop/c/z-runtime-export/consumer.c \
  examples/interop/c/z-runtime-export/build/libzembed.a \
  -o examples/interop/c/z-runtime-export/build/consumer

examples/interop/c/z-runtime-export/build/consumer
```

Expected output:

```text
busy=3 result=42 stopped=0
```

This consumer uses pthreads for a compact POSIX pressure test. The generated
runtime contract itself is platform-neutral; a Windows host uses its ordinary
thread and synchronization APIs around the same header functions.
