# Executor Placement Design Note

Status: ownership-aware placement blocks execute through structured task frames;
plain values, String copies, Z ARC classes, and Objective-C identity from an
owning async task are supported. Native-worker handoff and Darwin CFRunLoop
wakeups are implemented. Mutable/borrowed/native-affine capture contracts and
platform UI-loop adapters remain planned.

Date: 2026-07-20

This note records the intended relationship between executor placement,
structured concurrency, task results, and explicit operating-system threads.
It is a design checkpoint rather than an implementation-status claim.

## Design goal

Z should keep three concerns orthogonal:

1. **Placement:** where an operation is allowed or scheduled to execute.
2. **Concurrency:** whether the current task waits or forks a child task.
3. **Lifetime:** which structured scope owns and joins that child task.

The central source-level invariant is:

> `task` is the construct that visibly forks concurrent work. `on` specifies
> or proves execution placement. `async scope` owns child-task lifetime.

This avoids conflating executor affinity with thread creation or lexical task
joining.

## Executor values

Execution targets should be typed capabilities rather than platform-specific
keywords. The standard thread namespace owns the first target:

```z
import { thread } from "std/thread";
```

The same grammar can later work with a worker pool, actor, event loop, or
user-provided executor:

```z
import { thread } from "std/thread";

const ui = task on thread.main { /* ... */ };
const work = task on thread.pool { /* future shared compute target */ };
```

`thread.main` is the committed first spelling. Future targets such as pools or
application executors remain library capabilities; the language grammar depends
only on the expression after `on` having an executor-capability type.

## Three execution forms

### Synchronous placement proof

```z
const title = on thread.main {
  select window.title;
};
```

This form does not schedule or suspend. It compiles only when the surrounding
context is statically proven to execute on `main`. The block evaluates directly
to its selected value.

Using it from an unproven context is a compile error with guidance to use
`await on thread.main` or `task on thread.main`.

### Hop, wait, and receive a value

```z
const title = await on thread.main {
  select window.title;
};
```

If necessary, this form schedules the block on `main`, suspends the current
task, and resumes with the block's selected value. It does not expose a task
handle because the operation is immediately awaited.

If the current task is already proven to run on `main`, the implementation may
take a zero-hop fast path. `await on thread.main` does not promise an event-loop yield;
a future explicit operation such as `await main.yield()` should express that
request.

While execution remains lexically inside an `on thread.main` region, continuations
after nested suspension should resume on `main` unless the source explicitly
selects another executor.

### Fork a structured child on an executor

```z
const titleTask = task on thread.main {
  select window.title;
};

doOtherWork();
const title = await titleTask;
```

This form starts a hot child task on `main` and immediately returns its handle.
The expression has type `Task<T>` or `Task<T, E>`. The parent continues without
waiting, while the enclosing structured scope retains responsibility for
joining or cancelling the child.

`task on thread.main` preserves a concurrency boundary even when the caller already
runs on `main`; it follows ordinary `task` scheduling rather than becoming the
synchronous assertion form.

## Block contracts and type transformation

An optional annotation describes the block's success and error contract, not
the wrapper introduced by `task`:

```z
const task = task on thread.main: i32 throws TaskError {
  if (!condition) {
    throw TaskError({});
  }

  select 1;
};
```

The block contract is `i32 throws TaskError`. The execution form determines the
outer expression type:

| Form | Expression type |
|---|---|
| `try on thread.main: T throws E { ... }` | `T` |
| `try await on thread.main: T throws E { ... }` | `T` |
| `attempt await on thread.main: T throws E { ... }` | `Result<T, E>` |
| `task on thread.main: T throws E { ... }` | `Task<T, E>` |

Therefore this spelling is intentionally avoided:

```z
const result = await on thread.main: Task<i32, TaskError> { /* ... */ };
```

It obscures whether the block selects a task or the executor operation creates
one. The annotation after the executor should remain a function-like `T throws
E` contract.

Local blocks should infer their success type from `select` and their error type
from `throw` when unambiguous:

```z
const task = task on thread.main {
  if (!condition) throw TaskError({});
  select 1;
};
// Task<i32, TaskError>
```

Explicit contracts remain useful for numeric widths, complex branch
diagnostics, and intentional API stability.

## `select`, `return`, and path completeness

`select` supplies the value of the local executor-placement block:

```z
const answer = await on thread.main: i32 {
  select 42;
};
```

`return` retains its existing meaning: it exits the enclosing function or task,
running normal cleanup and structured joins. It does not merely provide the
block's value, and it does not stop the operating-system thread or executor.

The compiler should prove that:

- every successful path through a value-producing block reaches `select`;
- all selected values agree with the inferred or declared success type;
- every thrown value agrees with the inferred or declared error type;
- throwing, returning, or diverging paths do not also need to select; and
- a block with no selected value has success type `void`.

## Errors and acknowledgement

A fallible placed child preserves Z's normal typed error channel:

```z
const windowTask = task on thread.main: AppKit.NSWindow throws WindowError {
  if (application.keyWindow == null) {
    throw WindowError({ message: "No key window" });
  }

  select application.keyWindow;
};

const observed = attempt await windowTask;
```

A throwing child task must be explicitly acknowledged with `try await`,
`attempt await`, cancellation, or a future explicit scope error policy. A bare
fallible `task on` must not silently discard its error.

## Structured concurrency, not detachment

`task on thread.main` is "fire and continue," not true fire-and-forget:

```z
async scope {
  task on thread.main {
    window.updateDashboard(result);
  }

  continueBackgroundWork();
}
// The main-executor child is finished here.
```

Even when its handle is not bound, the child is owned and implicitly joined by
the enclosing `async scope`. The enclosing async function's root task scope
provides the same ownership rule outside an explicit nested scope.

Truly detached work has different lifetime and error semantics and remains a
separate future facility. A library operation such as `main.post(...)` may be a
better shape than weakening `task`; it would require owned captures, an
explicit error sink, and runtime-owned lifetime.

## Capture and transfer safety

An executor can run on the current thread, another thread, or a pool. Placement
alone must not imply that arbitrary captured storage is sendable.

The intended transfer rules reuse Z's ownership vocabulary and unified loan
checker:

- recursively plain values may copy;
- uniquely owned values may explicitly move;
- proven readonly ARC identity may share through atomic ARC;
- mutable shared state requires isolation rather than unchecked aliasing;
- native values require trusted transfer/share/destruction-affinity facts;
- borrows, views, and slices require a proven cross-executor loan lifetime; and
- the parent may not use a uniquely moved capture after the fork.

The planned explicit capture contract is a contextual `using` clause after the
executor expression:

```z
const compute = thread.pool({ threads: 4 });

const task = task on compute
  using (in config, inout value, move buffer)
  : i32 throws WorkError {
    value += config.increment;
    consume(move buffer);
    select value;
  };
```

`using` is contextual in this position rather than a globally reserved word.
Executor construction configures where and how operations run; `using (...)`
states how the placed operation may access existing bindings. Capture entries
reuse Z's ordinary capability vocabulary and do not repeat types:

- recursively Copy values may be inferred as private snapshots and omitted;
- `in binding` is an explicit readonly loan for a non-Copy capture;
- `inout binding` is one exclusive mutable loan;
- `move binding` transfers ownership into the placed operation; and
- `out` is deferred until failure, cancellation, and definite initialization
  have one sound child-task-output contract.

The same clause is intended to compose with all placement forms:

```z
on thread.main using (in window) { /* prove current placement */ }
await on thread.main using (in window) { /* hop and join */ }
task on thread.pool using (move work) { /* structured child */ }
```

An `in` or `inout` loan remains active until the child actually joins, either
through an explicit `await`/cancelling join or the enclosing `async scope`'s
implicit join. Merely requesting cancellation does not release a loan. The
parent may use the binding again after that join; a `move` capture remains moved
unless ownership is explicitly returned as the task result. This syntax and
the borrowed/mutable cross-executor tiers are planned, not yet executable.

The current executable tier applies these concrete rules:

- recursively plain captures copy into the placed task frame;
- `String` captures receive independent owned UTF-8 storage;
- Z class captures retain ARC identity and release it with the placed frame;
- Objective-C captures from the owning async task are held as ARC strong fields;
- a native worker may capture a deeply readonly/shareable Z class, but may not
  carry an Objective-C identity through itself merely to place it back on main;
- captured mutation, borrows/views/slices, and native resource owners remain
  rejected until their contracts can be proven.

The application-shaped path keeps UI identity in its main async task, lets a
worker return owned Z data, and then captures both in a main placement:

```z
const app = currentApplication();
const work = thread.spawn((): String => buildStatus());
const status = await work;

await on thread.main {
  publishStatus(app, status);
}
```

Because this final placement is a statement-form block, it needs no semicolon.
A binding such as `const title = await on thread.main { select ...; };` remains
a value expression and ends with one.

## Relationship to existing execution primitives

| Syntax | Meaning |
|---|---|
| `task operation()` | Fork a structured child on the inherited executor |
| `async scope { ... }` | Own and join lexical child tasks |
| `on thread.main { ... }` | Synchronously execute with statically proven main affinity |
| `await on thread.main { ... }` | Hop if necessary, wait, and produce `T` or `E` |
| `task on thread.main { ... }` | Fork a structured child placed on the existing main executor |
| `thread.spawn(operation)` | Allocate and start one dedicated OS thread |

`thread.spawn` is not defined by whether the OS thread has a debugging name.
Naming can be optional metadata:

```z
thread.spawn({ name: "image-decoder" }, move () => decode(image));
```

It still means one new dedicated OS thread, unlike `task on thread.main` or a future
`task on thread.pool`, which target existing executors.

### Dispatching from a native worker

`task on thread.main` should be legal inside the synchronous closure passed to
`thread.spawn`. This is Z's structured analogue of dispatching asynchronously
onto a platform main queue:

```z
const worker = thread.spawn(move () => {
  const snapshot = calculateSnapshot();

  task on thread.main {
    display(snapshot);
  };

  continueBackgroundWork();
});

await worker;
```

The placement operation does not suspend the native closure. The dedicated OS
thread may exit after its synchronous body finishes, while the owning worker
`Task` remains incomplete until its placed children finish. This preserves
structured lifetime without parking the OS thread. Cross-thread captures must
still satisfy transfer rules; main-isolated foreign references need explicit
affinity facts before they can be transported opaquely through a worker.

When the worker itself needs a value or ordered completion from main, it may be
explicitly async:

```z
const worker = thread.spawn(async move (): Status throws WorkError => {
  const status = try await buildStatus();

  await on thread.main {
    display(status);
  }

  return status;
});

const status = try await worker;
```

The worker owns a private executor. It stays alive while suspended,
`await on thread.main` places the child on the caller's main executor, and
completion enqueues the continuation back onto the private executor. Ordinary
continuations and `task` children therefore remain bound to the same dedicated
OS thread. Cooperative cancellation wakes a suspended worker so its structured
children and owned frame state unwind before the thread is joined.

## Foreign and Objective-C affinity

Foreign declarations need a way to state executor requirements that headers do
not encode. The exact `.zd` grammar remains to be designed, but it should reuse
declaration specification blocks rather than invent ad hoc wrapper code:

```z
declare module "AppKit/AppKit.h" {
  export function display(in window: NSWindow): void {
    on thread.main;
  }
}
```

The importer/FIIR should represent the semantic fact independently of the final
surface spelling. A call to a main-isolated API from an unproven context should
produce a targeted diagnostic and suggest an `await on thread.main` region.

Callbacks that an Objective-C API guarantees to invoke on main should establish
main-executor proof inside their bodies. Cross-thread callbacks instead need a
safe runtime handoff into a Z-owned executor/task scope.

The first C callback tier describes arbitrary native invocation with `thread
any`, but deliberately does not make `task on thread.main` detached. The
implemented bridge is the imported thread-safe `TaskScope`: it owns operations
submitted by foreign callbacks, rejects new operations during close, and joins
accepted work. `async scope updates {}` exposes that same handle as `updates`
without creating a second concurrency model. The current executable tier
accepts synchronous nonthrowing `(): void` operations or explicitly async,
nonthrowing `async (): void` roots placed on `thread.main`. The async form may
suspend and own structured workers; it handles typed child errors locally
because submission has no result task. Additional executors and supervisor
error policies remain future layers. Repeated callbacks may eventually lower
into an async generator so ordinary `try for await` owns registration and
cancellation.

## Function-level isolation

Z declarations place executor isolation in the declaration header:

```z
class NotesController on thread.main {
  function refresh(): void { /* main proof is established here */ }
}

struct WindowModel {
  controller: NotesController;
}

function displayError(in error: SaveError): void on thread.main {
  /* main proof is established here */
}
```

Methods, construction, stored-field access, cleanup, and deinitialization of an
isolated aggregate require the named executor. Affinity is transitive through
stored fields: `WindowModel` above is inferred as main-isolated because it owns
`controller`. Hover reports whether affinity was declared or inherited and
shows the field path that introduced it. Explicit spelling remains recommended
for exported API contracts.

The current executable tier requires both synchronous and async isolated calls
to occur under statically proven main context. Automatic scheduling when an
off-main caller invokes an async isolated function remains later lowering;
today the caller enters through `await on thread.main`. Isolated function
values are rejected rather than erasing the effect from an ordinary function
type.

## Scheduling and cancellation

- `on thread.main` performs no scheduling and has no runtime check when statically
  proven.
- `await on thread.main` may use a direct fast path when already isolated; otherwise it
  enqueues and suspends the current task.
- `task on thread.main` creates a hot structured child and lets the parent continue.
- Cancellation before a placed child starts should prevent its body from
  running when possible.
- Once running, cancellation remains cooperative and must preserve cleanup.
- Leaving a structured scope joins placed children just like inherited-executor
  children.

The Darwin adapter registers a `CFRunLoopSource` in common modes. A native
worker publishes placed frames through a mutex-protected inbound queue, signals
the source, and wakes the main run loop. The source drains ready Z tasks on the
actual main thread, including while AppKit owns the surrounding run loop.

The portable command-line executor and native-worker handoff also run on
Windows and POSIX hosts. Windows UI integration still needs a message-loop
adapter; Linux has no single system UI loop, so a GUI toolkit or application
will bind an executor capability. These are runtime adapters behind the same
`thread.main` semantics, not source-language forks.

Platform-specific imports will eventually be selected with a small compile-time
target facility exposed through `std/target`. The precise `comptime`/branch
syntax remains intentionally open, but platform branches must be eliminated
before semantic checking of unavailable imports and before native emission;
ordinary Z code should not inherit C preprocessor behavior.

## Alternatives deliberately rejected

### `scope main { ... }`

This conflates placement with lexical child-task lifetime. The explicit
composition remains clearer:

```z
await on thread.main {
  async scope {
    // ...
  }
}
```

### JavaScript label syntax

```z
main: {
  // ...
}
```

This looks like a JavaScript control-flow label while assigning unrelated
executor semantics. It would misuse rather than benefit from TypeScript
familiarity.

### Bare `on thread.main` always returning `Task<T, E>`

This hides the concurrency fork. Requiring `task on thread.main` preserves the rule
that every fork is visibly marked `task` and leaves a useful zero-cost
synchronous proof form.

### `return` as the block value

Z keeps `return` for the enclosing function/task and `select` for local
value-producing blocks. Last-expression inference can be reconsidered globally
later without making executor blocks a special case.

## Validation sequence

1. **Done:** parse and type-check the three forms.
2. **Done:** introduce the typed `thread.main` capability.
3. **Done:** execute synchronous, awaited, and child-task placement through task
   frames for `void`, scalar, and recursively plain values.
4. **Done:** publish placed children from `thread.spawn` through a thread-safe
   queue without equating OS-thread exit with task completion.
5. **Done on Darwin:** wake and drain the main executor through a
   `CFRunLoopSource`, including while an AppKit-compatible run loop is active.
6. **Partial:** integrate owned, ARC, native-affine, borrowed, cancellation, and
   cleanup capture contracts. String, Z ARC, and owning-task Objective-C captures
   are implemented; mutation, borrows, native ownership, and affinity metadata
   remain.
7. Carry main-affinity facts through FIIR and `.zd` declarations.
8. **Done for current syntax:** highlighting, completion, hover, definitions,
   and placement diagnostics.
9. Pressure-test the model in an application-shaped AppKit example, including
   target/action, callbacks, background work, and UI-thread resumption.
10. Add Windows message-loop and selected Linux GUI/event-loop adapters, driven
    by compile-time target selection rather than source preprocessing.
11. **Done:** support an async task bound to one dedicated `thread.spawn`
    worker, including child tasks, scheduler-aware delay, typed errors,
    cooperative cancellation, literal `await on thread.main`, and thread-affine
    continuation resumption back onto the same live worker thread.

## Open questions

- How are executor values created, retained, and compared for current-context
  proof?
- Which cross-executor borrows can the unified loan checker prove safely?
- Which inferred Copy captures should diagnostics ask users to spell explicitly
  for clarity or ABI stability?
- What eventual child-task `out` contract remains sound across failure and
  cancellation?
- What is the final function-level isolation syntax?
- What is the final `.zd` spelling for method, callback, and type affinity?
- Should any runtime-owned detached operation exist, and how must it report
  errors?
- How does the main executor integrate with application startup and shutdown?
- Which executor properties belong in FIIR: thread identity, seriality,
  reentrancy, destruction affinity, or actor-style isolation?

These questions are intentionally left open until implementation and the AppKit
pressure test provide evidence.
