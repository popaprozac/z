---
title: Threads, executors, and synchronization
description: Distinguish structured tasks from OS threads, preserve executor affinity, and share mutable state safely.
sidebar:
  order: 14
---

Z separates three ideas that are often conflated:

| Surface | Meaning |
| --- | --- |
| `task operation()` | Start a structured child on the current executor |
| `thread.spawn(operation)` | Create one native OS thread |
| `task on thread.main` / `await on thread.main` | Place work on the typed main executor |

Executor placement is not thread creation, and a task does not become
CPU-parallel merely because it can suspend.

## Native threads

Import the thread namespace explicitly:

```z
import { thread } from "std/thread";

async function main(): i32 {
  let readings = Array<i32>(20, 22);

  const calculation = thread.spawn(
    move () => readings[0] + readings[1]
  );
  // readings is unavailable: its owned buffer moved to the worker.

  const answer = await calculation;
  return answer;
}
```

A synchronous closure runs once on the new thread. An explicitly `async`
closure owns a private executor bound to that worker and resumes there after
supported suspension.

A capturing thread closure spells `move` because every capture must become
independent of the parent stack. The transfer classifier:

- Copies recursively cleanup-free values
- Moves unique owners such as `Array<T>` and owned `String`
- Atomically retains deeply readonly, cross-thread-shareable ARC identity
- Rejects borrows, views, arenas, and unproven mutable/native identities

For a copyable scalar, `move` owns a snapshot rather than making the parent's
binding disappear. A unique collection buffer genuinely transfers and becomes
unavailable in the parent.

## Main-executor placement

Use a direct placed call when a typed API must run on main:

```z
const title = await on thread.main readWindowTitle(window);
const loading = task on thread.main loadWindow(model);
const window = await loading;
```

- `await on thread.main` hops, waits, and returns the result.
- `task on thread.main` starts a hot structured child placed on main.
- Neither spelling creates a new OS thread.

An ordinary async service method can delegate its tail result to a
main-isolated method without making the whole service main-only:

```z
readonly class PublishService {
  async function publish(): i32 on thread.main {
    await delay(10);
    return 42;
  }

  async function invoke(): i32 {
    return await on thread.main this.publish();
  }
}
```

The parent remains a separately cancellable task. Cancellation is forwarded to
the suspended main-executor child, and both task frames retain their own
ownership cleanup.

A free helper has the same behavior:

```z
async function publish(service: PublishService): i32 on thread.main {
  await delay(10);
  return 42;
}

async function invoke(service: PublishService): i32 {
  return await on thread.main publish(service);
}
```

The same child can produce one local before synchronous continuation:

```z
async function invoke(service: PublishService): i32 {
  const status = await on thread.main publish(service);
  return status == 42 ? 0 : 1;
}
```

Typed failure keeps the same ordering and the same `try` spelling:

```z
async function invoke(
  service: PublishService
): i32 throws PublishError {
  const status = try await on thread.main publishChecked(service);
  return status == 42 ? 0 : 1;
}
```

The child transfers either the success value or the owned `PublishError` back
to the parent frame. Failure skips the success continuation and propagates from
`invoke`; cancellation remains a separate structural task outcome.

The fixed-point tier also composes ordinary service work with explicit main
publication:

```z
async function handle(
  service: SearchService,
  request: Request
): i32 {
  const routed = await service.route(in request);
  const published = await on thread.main publish(routed);
  return published.status;
}
```

Both awaits share one heap-owned parent frame. Borrowed value parameters point
into stable frame storage, owned results transfer between children exactly
once, and cancellation follows whichever child is active. This lets only the
UI publication be main-isolated instead of forcing the whole service handler
onto the main executor.

For anonymous multi-statement work, use a block and explicit ownership-bearing
captures:

```z
const updated = await on thread.main
  using (inout counter, move values): i32 {
    counter.value = counter.value + values[0];
    select counter.value;
  };
```

`using` applies Z's existing capability vocabulary to the capture boundary:

- `in` is a read-only loan until join.
- `inout` is an exclusive mutable loan until join.
- `move` consumes the source owner.
- Cleanup-free copy values and owned `String` snapshots may be inferred.

A borrowed `task on` capture requires an enclosing `async scope` so the compiler
has a lexical join boundary. Direct `await on` already joins before continuing.

## Executor-isolated declarations

Affinity is part of the declaration contract:

```z
class NotesController on thread.main {
  function showWindow(): void {
    // main proof is available throughout the class.
  }
}

function updateWindow(): void on thread.main {
  // main-only work
}
```

A mixed-affinity class can isolate only the native state that needs it:

```z
class Application {
  readonly name: String;
  readonly state: Mutex<ApplicationState>;
  window: AppKit.NSWindow on thread.main;

  function revision(): i32 {
    return state.withLock((in value) => value.revision);
  }

  function show(): void on thread.main {
    window.makeKeyAndOrderFront(null);
  }
}
```

The `Application` identity can travel opaquely while access to `window` and
`show()` remains guarded by main proof. Hover should expose the executor
contract and its originating field or type.

## Scoped shared mutation with `Mutex<T>`

```z
import { Mutex } from "std/sync";

struct State {
  completed: i32;
}

const state = Mutex(State({ completed: 0 }));

state.withLock((inout value): void => {
  value.completed = value.completed + 1;
});

const completed = state.withLock(
  (in value): i32 => value.completed
);
```

`withLock` blocks the current OS thread until it acquires the mutex. The closure
is synchronous and non-escaping; the protected `in` or `inout` borrow cannot be
returned, stored, captured by escaping work, or held across `await`.

The mutex is non-reentrant. A typed throw releases the lock normally and does
not poison it.

## Explicit application roots with `Once<T>`

`Once<T>` publishes one application-lifetime ARC identity without adding
module initialization order:

```z
import { Once } from "std/sync";

const application = Once<Application>();

async function main(): i32 on thread.main {
  const current = new Application({ name: "Z" });
  const lifetime = application.initialize(move current);

  const same = application.get();
  return same.name == "Z" ? 0 : 1;
} // lifetime removes the root
```

`initialize` publishes once and returns a move-only lifetime guard. `get()`
retains the same identity for the caller. It traps before initialization, after
the lifetime closes, or on duplicate initialization. Construction errors happen
before publication and are handled through ordinary `try`/`attempt`.

`Once<T>` synchronizes publication and retrieval. It does not make arbitrary
fields inside `Application` safe; mutable shared state still belongs behind a
mutex or executor contract.

## Typed asynchronous channels

Use `std/channel` when ownership should move through an explicit pipeline:

```z
import { Channel, ChannelClosed, Sender } from "std/channel";

struct Job {
  document: String;
}

async function produce(sender: Sender<Job>): void throws ChannelClosed<Job> {
  const job = Job({ document: "guide.md" });
  try await sender.send(move job);
  sender.close();
}

async function main(): i32 throws ChannelClosed<Job> {
  const { sender, receiver } = Channel<Job>.bounded(8);
  const producer = task produce(move sender);
  const next = await receiver.receive();
  try await producer;

  return match (next) {
    some(job) => i32(job.document.byteLength);
    none => 0;
  };
}
```

The returned endpoints intentionally have different authority. `Sender<T>` is
shareable between producers; `Receiver<T>` is unique. A full bounded channel
suspends `send` without blocking the executor. An empty open channel suspends
`receive`. Closing wakes waiters, drains buffered messages normally, and then
produces `Option.none`.

If closure wins a send race, `ChannelClosed<T>` preserves the unsent owner in
`error.value`. Cancellation unregisters a suspended waiter before destroying
its task frame.

Native threads can opt into blocking access explicitly:

```z
const syncSender = sender.sync();
const syncReceiver = receiver.sync(); // consumes the unique async receiver

try syncSender.send(move job);
const next = syncReceiver.receive();
```

Only `Channel<T>.bounded(capacity)` is implemented today, and capacity must be
greater than zero. `Channel<T>.unbounded()` is reserved as a distinct future
factory so storage policy never changes because an argument was omitted.

:::note[Cost model]
`thread.spawn` creates an OS thread and is much heavier than starting a task.
Main placement schedules through the platform executor. `Mutex<T>` uses native
blocking synchronization. Async channel waits suspend task frames; explicit
`SyncSender<T>` and `SyncReceiver<T>` operations block native threads.
Cross-thread shared ARC identity requires atomic
retains; thread-local ARC can avoid that cost when the compiler proves it local.
:::

:::caution[Platform coverage]
Darwin main-executor integration has received the deepest application testing.
Windows and Linux runtime adapters remain part of the portability work. The
type-level isolation model is cross-platform; UI-loop integration is necessarily
platform-specific.
:::

Runnable examples:
[thread transfer](https://github.com/popaprozac/z/blob/main/examples/async/thread-transfer.zs),
[executor placement](https://github.com/popaprozac/z/blob/main/examples/async/executor-placement.zs),
[bounded channels](https://github.com/popaprozac/z/blob/main/examples/async/channels.zs),
and [mutex state](https://github.com/popaprozac/z/blob/main/examples/language/ownership/mutex-state.zs).
