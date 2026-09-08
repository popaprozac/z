---
title: Async and structured concurrency
description: Start owned child tasks, join lexical scopes, propagate typed failures, and cancel without detaching work.
sidebar:
  order: 13
---

An `async function` describes work that may suspend. Its source result remains
`T` or `T throws E`; calling it produces task-shaped work that must be awaited
or started as a structured child.

```z
async function fetchValue(id: i32): i32 {
  return id;
}

async function main(): i32 {
  const value = await fetchValue(42);
  return value;
}
```

`await` starts and joins the operation at that point. The current task may
suspend; the OS thread or executor is free to perform other work.

## Start work with `task`

`task` starts a hot structured child immediately:

```z
async function main(): i32 {
  const firstTask = task fetchValue(20);
  const secondTask = task fetchValue(22);

  doSynchronousWork();

  const first = await firstTask;
  const second = await secondTask;
  return first + second;
}
```

The benefit is the interval between creation and join: both child operations
can make progress while the parent does other work. `await task operation()` is
usually equivalent to directly awaiting the operation and creates no useful
overlap.

The `task` keyword creates a `Task<T, E>` handle. It does not create an OS
thread. Use `thread.spawn` when the work must run on a new native thread.

## Lexical scopes join children

Every child belongs to a scope. An async function body is an implicit root task
scope; `async scope` creates a narrower join boundary:

```z
async function refresh(): void throws NetworkError {
  async scope {
    task refreshUser();
    task refreshPosts();
  }

  publishRefreshedUI(); // both children have finished
}
```

Leaving the scope joins every child. This remains true when a handle is not
awaited explicitly, so structured work cannot silently become a detached
background operation.

The scope is useful because two sequential `await` expressions would not run
the operations concurrently:

```z
await refreshUser();
await refreshPosts(); // starts after refreshUser completes
```

## Errors stay typed

Combine suspension with the ordinary error vocabulary:

```z
const value = try await fetchValue(42);
const result = attempt await fetchValue(42);
```

`try await` joins and propagates `E`. `attempt await` joins and produces
`Result<T, E>` for local matching.

When a child failure propagates out of a scope, live siblings are cancelled and
joined before the parent completes. Cancellation is a structural task outcome,
not an invented variant of every domain error type.

## Caller cancellation

A task handle owns the authority to join or cancel one child:

```z
async scope {
  const pending = task download();

  if (noLongerNeeded()) {
    await pending.cancel();
  } else {
    const result = await pending;
    publish(result);
  }
}
```

`cancel()` requests cancellation and joins. It does not abandon the task frame
or its owned values. Cleanup runs exactly once whether completion or
cancellation wins.

## Delays and cooperative yielding

An async delay suspends without blocking the executor thread:

```z
import { delay } from "std/time";

async function finishLater(): void {
  await delay(1000);
}
```

Synchronous `sleep` is a different API: it blocks the current OS thread and is
appropriate only when blocking is intentional.

Long CPU loops on an async executor can cooperate explicitly:

```z
import { scheduler } from "std/async";

async function index(in records: Array<Record>): void {
  for (const record of records) {
    indexRecord(record);
    await scheduler.yield();
  }
}
```

`scheduler.yield()` requeues the current task and creates a cancellation
observation point. It does not sleep, switch executors, or yield a generator
element.

## Dynamic task scopes

`async scope updates {}` binds a `TaskScope` handle when callbacks must submit
work dynamically. `scope.schedule(thread.main, operation)` returns a
`TaskControl`, which can request cancellation but does not own joining. The
scope remains the sole lifetime owner and rejects new submissions while it
closes.

This advanced form is especially useful for native callbacks. Ordinary lexical
child work should prefer unnamed `async scope` and the `task` keyword.

:::note[Cost model]
Suspending async functions use owned task frames. Directly completed operations
can finish without suspension; live locals that cross an await reside in the
frame. A fresh aggregate passed by `in` to a direct-awaited operation is
materialized in address-stable parent-frame storage and cleaned after the child
is torn down. `task` adds child scheduling and join state; because that hot
child may outlive its starting expression, borrowed task arguments still use
named storage inside an `async scope`. `async scope` owns its children and may
lower statically when every child is lexical.
:::

:::caution[Pre-alpha composition]
The accepted model is broader than every fixed-point native lowering tier.
General suspension counts, nested control-flow combinations, and some
ownership-bearing frame shapes are still expanding. Stage 0 executes owned
value-struct destructuring at the function root or directly inside an explicit
`async scope`, including awaited producers and cancellation cleanup. Owned
branch/loop locals still need that explicit lexical scope; borrowed-view and
array patterns in async frames are not yet executable. The fixed-point native
compiler now executes root Z-owned patterns across `scheduler.yield()`, including
yields in nested `if`/`while` statements. This tier supports owned Z-value
parameters in non-throwing `void`/`i32` functions without explicit declaration
affinity. Inputs enter the cold frame before its body runs, including cleanup
if it is dropped or cancelled before entry. Mutex-backed state and Objective-C
references can also live in these frames, with explicit strong-slot cleanup.
Scoped `withLock` callbacks release their lock before the next yield. Borrowed
parameters, other foreign storage, child awaits, and nested source-local declarations
remain separate composition work. These are implementation boundaries, not
new ownership rules. A successful `check` alone is not proof that an advanced
frame shape can be emitted and run. Check the
[implementation status](/reference/status/) when an advanced async composition
produces `Z0700`.
:::

Runnable examples:
[async overview](https://github.com/popaprozac/z/blob/main/examples/async/async-overview.zs),
[scopes](https://github.com/popaprozac/z/blob/main/examples/async/async-scopes.zs),
[bounded channels](https://github.com/popaprozac/z/blob/main/examples/async/channels.zs),
and [cancellation](https://github.com/popaprozac/z/blob/main/examples/async/async-caller-cancellation.zs).

Next: [Threads, executors, and synchronization](/language-tour/threads-executors-and-synchronization/).
