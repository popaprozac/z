---
title: Files, processes, and system APIs
description: Use explicit standard modules for owned I/O, native child processes, clocks, and blocking operations.
sidebar:
  order: 16
---

Operating-system capabilities are standard modules rather than magical
globals. Importing them makes both dependency and cost visible:

```z
import console from "std/console";
import fs from "std/fs";
import process from "std/process";
import { delay, sleep } from "std/time";
```

## Read and write owned data

Filesystem failures use normal typed Z errors:

```z
function load(in path: String): String throws String {
  return try fs.readText(path);
}
```

`fs.readText` returns an owned, validated UTF-8 `String`. Use `fs.readBytes`
when arbitrary bytes are valid; it returns an owned `Array<u8>` without text
decoding.

```z
function stage(in sourcePath: String): void throws String {
  const source = try fs.readText(sourcePath);

  try fs.createDirectories(".z-cache");
  try fs.writeText(".z-cache/output.pending", source);
  try fs.replace(
    ".z-cache/output.pending",
    ".z-cache/output.zs"
  );
}
```

`fs.replace` performs an atomic same-filesystem directory-entry replacement.
It prevents readers from observing a partially written output; it does not by
itself promise persistence after sudden power loss.

Useful queries include:

| API | Result |
| --- | --- |
| `fs.exists(path)` | Non-throwing existence check |
| `fs.isDirectory(path)` | Whether an existing path is a directory |
| `fs.realPath(path)` | Owned canonical absolute UTF-8 path or typed failure |
| `fs.createDirectories(path)` | Creates every missing parent |

## Locks are deterministic resources

An interprocess file lock is a move-only owner:

```z
function publish(): void throws String {
  const lock: fs.Lock = try fs.lock(".z-cache/build.lock");
  try fs.writeText(".z-cache/result.txt", "ready");
  // lock is released on scope exit
}
```

Early release is consuming:

```z
lock.unlock();
// lock is no longer usable
```

The file may remain on disk after release; the operating system lock itself is
released deterministically on scope exit, error propagation, early return, or
explicit `unlock()`.

Use `std/sync`'s `Mutex<T>` for synchronous in-process shared state. A file lock
exists for coordination across processes and protects a different boundary.

## Launch child processes without a shell

```z
import process from "std/process";

function clangVersion(): i32 throws String {
  const arguments = Array<String>("--version");
  return try process.run("clang", arguments);
}
```

`process.run` launches the executable directly, inherits the current standard
streams, waits for completion, and returns the child exit code. It does not
invoke a shell, interpolate a command string, or treat a nonzero child exit as
a launch failure. Failure to launch or wait throws a typed `String` OS error.

Program arguments are owned values:

```z
const arguments = process.args();
const executable = try process.executablePath();
```

`process.args()` excludes the executable name. `process.executablePath()`
returns the running Z binary's canonical path, which is useful for locating
resources or helpers shipped beside it.

From the CLI, separate compiler and program arguments with `--`:

```sh
z run . -- input.zs --verbose
```

## Blocking sleep and async delay differ

```z
sleep(100);       // blocks the current OS thread
await delay(100); // suspends the current task
```

Both durations are milliseconds. Use `sleep` only when occupying the current
thread is intentional, such as a dedicated native worker. `delay` requires an
async context and lets the executor run other work while the task waits.

:::note[Portability]
The public APIs are intended to keep portable semantics while their thin
native substrate differs by target. macOS has received the deepest current
pressure. Windows and Linux implementations and continuous coverage remain an
active hardening area rather than an implied guarantee from the C backend.
:::

:::note[Cost model]
Reads allocate owned storage. Writes borrow their inputs for the call. A file
lock and `process.run` block the current OS thread. `delay` stores a suspended
task continuation instead of blocking that thread.
:::

Runnable examples:
[source stager](https://github.com/popaprozac/z/tree/main/examples/applications/source-stager),
[source inspector](https://github.com/popaprozac/z/tree/main/examples/applications/source-inspector),
and [blocking sleep](https://github.com/popaprozac/z/blob/main/examples/language/basics/sleep.zs).

Next: [Testing, projects, and the CLI](/language-tour/testing-projects-and-cli/).
