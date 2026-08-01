# Embedding the Z runtime

This static-library example isolates the lifecycle contract generated for a Z
library. `initializeRuntime` installs a main-bound application in `Once` and
returns its `OnceLifetime`; generated shutdown owns and destroys that guard.
The application deliberately mixes a main-only `uiRevision` with a
`Mutex<EmbeddedState>` surface that is safe from entered native threads.
The handwritten C host:

1. proves initialization from a worker reports `ZEMBED_RUNTIME_WRONG_THREAD`;
2. initializes `zembed` on main with host identity/release hooks;
3. enters a Z export from a pthread worker, retrieves the root with
   `Once.get()`, and records a completed job under `Mutex`;
4. proves shutdown reports `ZEMBED_RUNTIME_BUSY` while that call is live;
5. releases and joins the worker, then reads the persistent synchronized state
   through a second exported call; and
6. begins shutdown, receives `ZEMBED_RUNTIME_DRAINING` while the queued
   main-thread root release is pending, drains that host queue, and then
   completes shutdown with the root's `deinit` observed exactly once.

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
wrong=6 busy=3 completed=1 checksum=43 draining=7 stopped=0 released=1
```

The compiler test also attempts to read `uiRevision` from the ordinary worker
export and requires a main-executor diagnostic. Entering Z makes synchronized
state available; it does not manufacture permission to access main-only state.

This consumer uses pthreads for a compact POSIX pressure test. The generated
runtime contract itself is platform-neutral; a Windows host uses its ordinary
thread and synchronization APIs around the same header functions.
