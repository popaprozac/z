# Executor Placement Design Note

Status: scalar and recursively plain placement blocks execute through structured
task frames; native-worker handoff and Darwin CFRunLoop wakeups are implemented.
Owned/borrowed capture contracts and platform UI-loop adapters remain planned.

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

> `spawn` is the construct that visibly forks concurrent work. `on` specifies
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

const ui = spawn on thread.main { /* ... */ };
const work = spawn on thread.pool { /* future shared compute target */ };
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
`await on thread.main` or `spawn on thread.main`.

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
const titleTask = spawn on thread.main {
  select window.title;
};

doOtherWork();
const title = await titleTask;
```

This form starts a hot child task on `main` and immediately returns its handle.
The expression has type `Task<T>` or `Task<T, E>`. The parent continues without
waiting, while the enclosing structured scope retains responsibility for
joining or cancelling the child.

`spawn on thread.main` preserves a concurrency boundary even when the caller already
runs on `main`; it follows ordinary `spawn` scheduling rather than becoming the
synchronous assertion form.

## Block contracts and type transformation

An optional annotation describes the block's success and error contract, not
the wrapper introduced by `spawn`:

```z
const task = spawn on thread.main: i32 throws TaskError {
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
| `spawn on thread.main: T throws E { ... }` | `Task<T, E>` |

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
const task = spawn on thread.main {
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
const windowTask = spawn on thread.main: AppKit.NSWindow throws WindowError {
  if (application.keyWindow == null) {
    throw WindowError({ message: "No key window" });
  }

  select application.keyWindow;
};

const observed = attempt await windowTask;
```

A throwing spawned task must be explicitly acknowledged with `try await`,
`attempt await`, cancellation, or a future explicit scope error policy. A bare
fallible `spawn on` must not silently discard its error.

## Structured concurrency, not detachment

`spawn on thread.main` is "fire and continue," not true fire-and-forget:

```z
async scope {
  spawn on thread.main {
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
better shape than weakening `spawn`; it would require owned captures, an
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

The exact capture spelling for a placed block remains open. Possible source
shapes should be evaluated against existing move closures and real application
examples before adding syntax.

## Relationship to existing execution primitives

| Syntax | Meaning |
|---|---|
| `spawn operation()` | Fork a structured child on the inherited executor |
| `async scope { ... }` | Own and join lexical child tasks |
| `on thread.main { ... }` | Synchronously execute with statically proven main affinity |
| `await on thread.main { ... }` | Hop if necessary, wait, and produce `T` or `E` |
| `spawn on thread.main { ... }` | Fork a structured child placed on the existing main executor |
| `thread.spawn(operation)` | Allocate and start one dedicated OS thread |

`thread.spawn` is not defined by whether the OS thread has a debugging name.
Naming can be optional metadata:

```z
thread.spawn({ name: "image-decoder" }, move () => decode(image));
```

It still means one new dedicated OS thread, unlike `spawn on thread.main` or a future
`spawn on thread.pool`, which target existing executors.

### Dispatching from a synchronous native worker

`spawn on thread.main` should be legal inside the synchronous closure passed to
`thread.spawn`. This is Z's structured analogue of dispatching asynchronously
onto a platform main queue:

```z
const worker = thread.spawn(move () => {
  const snapshot = calculateSnapshot();

  spawn on thread.main {
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

Async closures passed directly to `thread.spawn` remain a future extension, not
a rejected design. Supporting them requires a thread-affine executor and an
explicit continuation rule: after awaiting another executor, Z must define
whether execution resumes on the exact dedicated thread and how that thread is
kept alive while suspended. Typed channels and structured placed children cover
the initial progress-reporting use cases without closing that future path.

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

## Function-level isolation

Functions will eventually need executor-affinity contracts. Two distinct
semantics are useful:

- a synchronous main-isolated function can be called only from a proven main
  context; and
- an async main-isolated function returns a task and can schedule onto main for
  an off-main caller.

The exact declaration syntax is intentionally not settled by this note.
Candidates must be reviewed alongside return types, `throws`, methods, and
foreign declarations rather than introduced opportunistically.

## Scheduling and cancellation

- `on thread.main` performs no scheduling and has no runtime check when statically
  proven.
- `await on thread.main` may use a direct fast path when already isolated; otherwise it
  enqueues and suspends the current task.
- `spawn on thread.main` creates a hot structured child and lets the parent continue.
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

This hides the concurrency fork. Requiring `spawn on thread.main` preserves the rule
that every fork is visibly marked `spawn` and leaves a useful zero-cost
synchronous proof form.

### `return` as the block value

Z keeps `return` for the enclosing function/task and `select` for local
value-producing blocks. Last-expression inference can be reconsidered globally
later without making executor blocks a special case.

## Validation sequence

1. **Done:** parse and type-check the three forms.
2. **Done:** introduce the typed `thread.main` capability.
3. **Done:** execute synchronous, awaited, and spawned placement through task
   frames for `void`, scalar, and recursively plain values.
4. **Done:** publish placed children from `thread.spawn` through a thread-safe
   queue without equating OS-thread exit with task completion.
5. **Done on Darwin:** wake and drain the main executor through a
   `CFRunLoopSource`, including while an AppKit-compatible run loop is active.
6. Integrate owned, ARC, native-affine, borrowed, cancellation, and cleanup
   capture contracts. The current runtime tier copies recursively plain captures
   and rejects mutation through a capture.
7. Carry main-affinity facts through FIIR and `.zd` declarations.
8. **Done for current syntax:** highlighting, completion, hover, definitions,
   and placement diagnostics.
9. Pressure-test the model in an application-shaped AppKit example, including
   target/action, callbacks, background work, and UI-thread resumption.
10. Add Windows message-loop and selected Linux GUI/event-loop adapters, driven
    by compile-time target selection rather than source preprocessing.

## Open questions

- How are executor values created, retained, and compared for current-context
  proof?
- What explicit capture syntax is required when a placed task moves ownership?
- Which cross-executor borrows can the unified loan checker prove safely?
- What is the final function-level isolation syntax?
- What is the final `.zd` spelling for method, callback, and type affinity?
- Should any runtime-owned detached operation exist, and how must it report
  errors?
- How does the main executor integrate with application startup and shutdown?
- Which executor properties belong in FIIR: thread identity, seriality,
  reentrancy, destruction affinity, or actor-style isolation?

These questions are intentionally left open until implementation and the AppKit
pressure test provide evidence.
