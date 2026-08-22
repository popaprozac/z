# Executor Placement Design Note

Status: direct placed calls and ownership-aware placement blocks execute through
structured task frames. Async direct calls use the callee frame without nesting
`Task`; plain values, String copies, Z ARC classes, and Objective-C identity
from an owning async task are supported. Placement blocks accept explicit
`using (in value, inout state, move owner)` capture contracts. Native-worker
handoff and Darwin CFRunLoop wakeups are implemented. `out` capture, executors
beyond `thread.main`, and Windows/Linux UI-loop adapters remain planned.

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

## Two execution forms

Executor proof comes from the enclosing declaration or placement. Code already
running under a declaration such as `function title(): String on thread.main`
accesses main-isolated state directly; Z deliberately has no subjectless
`on thread.main { ... }` proof block.

### Hop, wait, and receive a value

```z
const title = await on thread.main readWindowTitle(window);

const title = await on thread.main {
  select window.title;
};
```

The direct-call form uses the callee's parameter capabilities as its transfer
and loan boundary. The block form is for anonymous multi-statement work and
uses `select` to provide its value. If necessary, either form schedules the
operation on `main`, suspends the current task, and resumes with its value. It
does not expose a task handle because the operation is immediately awaited.

If the current task is already proven to run on `main`, the implementation may
take a zero-hop fast path. `await on thread.main` does not promise an event-loop
yield; `await scheduler.yield()` explicitly cooperates with the current
executor instead.

While execution remains lexically inside an `on thread.main` region, continuations
after nested suspension resume on `main` unless the source explicitly selects
another executor:

```z
const value = await on thread.main {
  select await mainIsolatedOperation();
};
```

The two `await` keywords describe different boundaries. The outer one hops to
and joins the main placement. The inner one suspends the operation while
retaining main-executor proof.

### Fork a structured child on an executor

```z
const titleTask = task on thread.main readWindowTitle(window);

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

`task on thread.main` preserves a concurrency boundary even when the caller
already runs on `main`; it follows ordinary `task` scheduling.

When the direct callee is async, placement schedules that callee's task frame
directly. `task on thread.main load()` therefore has type `Task<T, E>`, never
`Task<Task<T, E>>`. A synchronous direct call is wrapped in a minimal one-shot
placed frame. The current bootstrap requires an async adapter for a throwing
synchronous direct call because synchronous `try` lowering inside task frames
is still pending.

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

The explicit capture contract is a contextual `using` clause after the executor
expression:

```z
const task = task on thread.main
  using (in config, inout value, move buffer)
  : i32 throws WorkError {
    value += config.increment;
    consume(move buffer);
    select value;
  };
```

`using` is contextual in this position rather than a globally reserved word.
The executor configures where the operation runs; `using (...)` states how the
placed operation may access existing bindings. Capture entries reuse Z's
ordinary capability vocabulary and do not repeat types:

- cleanup-free recursively Copy values and owned String snapshots may be
  inferred as private snapshots and omitted;
- `in binding` is an explicit readonly loan for a non-Copy capture;
- `inout binding` is one exclusive mutable loan;
- `move binding` transfers ownership into the placed operation; and
- `out` is deferred until failure, cancellation, and definite initialization
  have one sound child-task-output contract.

For value storage, `inout` requires a mutable `let` binding. ARC class binding
immutability remains distinct from instance mutation: a `const` class reference
may appear as `inout` when the placed operation invokes mutable class behavior,
while the reference itself is not rebound.

The same clause composes with both placement forms:

```z
await on thread.main using (in window) { /* hop and join */ }
task on thread.pool using (move work) { /* structured child */ }
```

An `in` or `inout` loan remains active until the child actually joins, either
through an explicit `await`/cancelling join or the enclosing `async scope`'s
implicit join. Merely requesting cancellation does not release a loan. The
parent may use the binding again after that join; a `move` capture remains moved
unless ownership is explicitly returned as the task result. A borrowed capture
on `task on` requires an explicit `async scope`; an awaited placement already
provides the join. Direct calls need no `using` clause:

```z
const value = await on thread.main refresh(inout state);
const loading = task on thread.main load(model);
```

The callee declaration and its ordinary arguments are already the capability
boundary. Direct awaited async `inout`/`out` loans remain active until the
placed call completes; a hot child loan follows the same explicit
`async scope` and join rules as an ordinary `task` call.

The current executable tier applies these concrete rules:

- recursively plain captures copy into the placed task frame;
- omitted `String` captures receive independent owned UTF-8 storage;
- `in` borrows a capture read-only until join;
- `inout` exclusively borrows mutable caller storage until join;
- `move` transfers a unique owner into the placed task frame;
- a native worker may capture a deeply readonly/shareable Z class normally;
- it may carry a `thread.main`-isolated Z class opaquely, access it only inside
  a nested main placement, and release that transferred retain back on main;
- it may not carry raw Objective-C identity through itself merely to place it
  back on main;
- `out` capture remains deferred until failure, cancellation, and definite
  initialization share one sound child-output rule; and
- the only executable placement target is currently `thread.main`; pool
  executors remain planned.

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
| `await on thread.main operation()` | Place and immediately join one direct call |
| `task on thread.main operation()` | Place one direct call as a structured child |
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

`task on thread.main` is legal inside the synchronous closure passed to
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
still satisfy transfer rules.

A wholly main-isolated Z ARC identity may be retained on main and carried
opaquely by the worker:

```z
class Presenter on thread.main {
  label: AppKit.NSTextField;

  function publish(in status: String): void {
    this.label.stringValue = status;
  }
}

const presenter = new Presenter({ label });
const worker = thread.spawn(async move (): i32 => {
  const answer = await calculate();
  await on thread.main {
    presenter.publish(`Ready: ${answer}`);
  }
  return answer;
});
```

The worker has no permission to dereference, alias, return, retain, or release
`presenter`. The placement child borrows the pointer. Once the worker is done,
its transferred retain is queued to the main executor for release. This is
transport of an executor-bound capability, not general thread sharing. Its ARC
counter is atomic for transport, while member access and final destruction
remain executor-checked. Raw Objective-C references remain rejected as worker
captures.

A class with member-level isolation is less restrictive:

```z
class Application {
  readonly name: String;
  readonly state: Mutex<ApplicationState>;
  window: AppKit.NSWindow on thread.main;

  function revision(): i32 {
    return this.state.withLock((in value): i32 => value.revision);
  }

  function show(): void on thread.main {
    this.window.makeKeyAndOrderFront(null);
  }
}
```

Construction and destruction remain on main because `window` is stored there.
The ARC identity may cross a native worker with the same explicit `move`
closure boundary. `revision()` and the readonly thread-safe fields remain
available on that worker; `window` and `show()` do not. Mutable or
non-shareable unannotated fields are conservatively treated as main-only.

When the worker itself needs a value or ordered completion from main, it may be
explicitly async:

```z
const worker = thread.spawn(async move (): Status throws WorkError => {
  const status = try await on thread.main: Status throws WorkError {
    select try await buildMainStatus();
  }

  return status;
});

const status = try await worker;
```

The worker owns a private executor. It stays alive while suspended,
`await on thread.main` places the child on the caller's main executor, the
nested `await` resumes within that placement, and completion enqueues the outer
continuation back onto the private executor. Ordinary continuations and `task`
children therefore remain bound to the same dedicated OS thread. Cooperative
cancellation is delivered to the executor that owns each child, so a suspended
worker can unwind structured children and owned frame state before the thread
is joined.

## Foreign and Objective-C affinity

Foreign declarations can state executor requirements that headers do not
encode while preserving the imported ABI:

```z
declare module "AppKit/AppKit.h" {
  export function display(in window: NSWindow): void on thread.main;
}
```

The importer/FIIR should represent the semantic fact independently of the final
surface spelling. A call to a main-isolated API from an unproven context should
produce a targeted diagnostic and suggest an `await on thread.main` region.

Callbacks that an Objective-C API guarantees to invoke on main should establish
main-executor proof inside their bodies. Cross-thread callbacks instead need a
safe runtime handoff into a Z-owned executor/task scope.

The first checked callback tier describes arbitrary native invocation with
`thread any`, but deliberately does not make `task on thread.main` detached.
Generated C callback trampolines and ARC-owned Objective-C block adapters both
enter the runtime captured when the callback was registered, including while
native release destroys the closure environment. This covers blocks surfaced
by generated Swift Objective-C headers as well as direct Objective-C APIs. The
bounded entry permits atomic ARC, synchronized `Once<T>.get()`, mutex access,
and executor-routed final release; it does not turn the foreign thread into a Z
executor or grant main proof. Nested entry restores the previous thread context
on every return path, and the callback box keeps the owning executor alive
until native release.

The imported thread-safe `TaskScope` then owns operations submitted by foreign
callbacks, rejects new operations during close, and joins accepted work.
`async scope updates {}` exposes that same handle as `updates`
without creating a second concurrency model. The current executable tier
accepts synchronous nonthrowing `(): void` operations or explicitly async,
nonthrowing `async (): void` roots placed on `thread.main`. The async form may
suspend and own structured workers; it handles typed child errors locally
because submission has no result task. `schedule` returns a non-joining
`TaskControl` for the admission race and per-operation cancellation; the scope
still joins every accepted root. Additional executors and supervisor
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
isolated aggregate require the named executor. Affinity remains transitive
through inline value and native storage. ARC class fields are the deliberate
exception: `WindowModel` stores a retained, executor-routed handle, so the
model may carry that identity without inheriting whole-value isolation.
`controller.refresh()` still requires main proof, and constructing or finally
destroying `NotesController` still belongs to main. Hover identifies the field
as a transportable ARC handle and preserves the referenced class's member
contract.

This does not make every containing aggregate automatically transferable
between OS threads; ordinary `thread.spawn` capture and ownership rules still
apply to the complete value graph. It permits construction, return, storage,
and cleanup of the ARC handle on a registered worker because atomic retain and
executor-routed final release already preserve its lifecycle.

The current executable tier requires both synchronous and async isolated calls
to occur under statically proven main context. Automatic scheduling when an
off-main caller invokes an async isolated function remains later lowering;
today the caller enters through `await on thread.main`. Isolated function
values are rejected rather than erasing the effect from an ordinary function
type.

## Member-level isolation

The same suffix may follow a stored field type:

```z
class Application {
  readonly identifier: String;
  readonly state: Mutex<ApplicationState>;
  window: AppKit.NSWindow on thread.main;

  function identifierByteLength(): usize {
    return this.identifier.byteLength;
  }

  function centerWindow(): void on thread.main {
    this.window.center();
  }
}
```

This is a positive capability restriction. A whole declaration written
`class Application on thread.main` remains wholly isolated; Z does not add a
`nonisolated` member escape. For a mixed-affinity class, the isolated field
still determines construction, destruction, and cleanup placement, while
unrelated readonly thread-safe members retain any-thread access. `Mutex<T>` is
the intended route to synchronized mutable state.

An unrestricted method receives no implicit main proof. Accessing `window`
therefore diagnoses at the method body and asks for `on thread.main`.
Unrestricted methods cannot pass, return, copy, or otherwise escape bare
`this`; they may use accessible members and call other unrestricted methods.
Trait conformance follows substitutability: an unrestricted implementation may
satisfy a main-only requirement, but a main-only implementation cannot satisfy
an unrestricted requirement.

## Scheduling and cancellation

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

### Bare `on thread.main { ... }`

This has no subject describing whether the operation hops, waits, forks, or
merely asserts existing proof. Because existing proof already permits direct
access, the bare form adds no authority. Z requires `await on` or `task on`
when placement performs work.

### Placing `on executor` after a task body

```z
task { /* ... */ } on thread.main
```

The scheduling target should be visible before the operation body. Expression
placement therefore keeps the operator-first `task on executor` and
`await on executor` order, while declaration contracts remain suffixes such as
`function update(): void on thread.main`.

### `return` as the block value

Z keeps `return` for the enclosing function/task and `select` for local
value-producing blocks. Last-expression inference can be reconsidered globally
later without making executor blocks a special case.

## Validation sequence

1. **Done:** parse and type-check awaited and child-task placement; the
   redundant synchronous proof form was removed before alpha.
2. **Done:** introduce the typed `thread.main` capability.
3. **Done:** execute awaited and child-task placement through task frames for
   `void`, scalar, and recursively plain values.
4. **Done:** publish placed children from `thread.spawn` through a thread-safe
   queue without equating OS-thread exit with task completion.
5. **Done on Darwin:** wake and drain the main executor through a
   `CFRunLoopSource`, including while an AppKit-compatible run loop is active.
6. **Partial:** integrate owned, ARC, native-affine, borrowed, cancellation, and
   cleanup capture contracts. String, Z ARC, owning-task Objective-C captures,
   opaque main-isolated Z class transport with main-executor release, and
   native executor-affinity metadata are implemented; mutation,
   cross-executor borrows, raw foreign-identity transport, and broader native
   ownership remain.
7. **Done for the main-executor tier:** carry main-affinity facts through FIIR,
   automatically import explicit Clang actor attributes and `@MainActor` facts
   from declared Swift-target symbol graphs, accept `on thread.main` fallbacks
   in `.zd`, and ship reviewed AppKit type notes where its Objective-C headers
   do not uniformly carry actor metadata.
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
12. **Done:** accept a direct call operand after an
    executor, for example `task on thread.main load(value)` and
    `try await on thread.main load(inout state)`. The function arguments are
    the capability boundary and therefore need no `using` clause. Placement
    blocks retain `using (...)` for lexical captures and multiple statements.
13. **Partial in the fixed-point native backend:** a dedicated worker can send
    owned value arguments to either a synchronous nonthrowing main-isolated
    function or the current taskified suspending shape, then receive scalar,
    ownership-bearing, or typed-error results without deadlocking the joining
    main thread. A main-isolated callee may contain multiple top-level literal
    `await delay(...)` statements, with synchronous expression statements
    before and between them, and uses the placed call as the worker closure's
    tail return. The callee may alternatively contain one top-level braced
    `if`/`else` whose branches contain direct literal delays. Its condition runs
    once on main, only the selected branch waits, and both paths rejoin before
    the following statements. A third supported shape is one top-level
    consuming `match` over an enum-valued expression, including cleanup-free or
    cleanup-bearing payload bindings, with braced arms containing direct
    literal delays. Its subject is evaluated once into the invocation frame on
    main. A named owner transfers into that frame; a computed call or enum
    construction is adopted there directly. A cleanup-bearing active payload
    transfers between the subject slot and selected arm binding at each segment
    boundary, so normal cleanup, move-out, typed failure, and cancellation each
    destroy it exactly once. The
    worker waits only along the selected arm, and every arm rejoins before the
    suffix. The fourth supported shape is one top-level braced `while` whose
    body contains direct literal delays. Its condition is reevaluated on main
    before every iteration. Synchronous body segments also run on main, while
    the worker owns repetition and cancellable waits. Ordinary `break` and
    `continue` preserve their source meaning across those boundaries, and
    cleanup-bearing iteration locals are destroyed exactly once on normal
    iteration exit, loop control, function exit, or cancellation. `return` and
    `throw` evaluate on main, run the ordinary cleanup plan, and transfer the
    completed success or typed failure directly back to the waiting worker.
    A direct synchronous `try` binding, assignment, or expression statement
    uses the same path: success continues on main and an owned success value
    may cross the next wait in the existing frame; failure runs the ordinary
    cleanup plan and completes the callee's typed result. Main executes each
    synchronous segment; the worker performs each cancellable
    wait without occupying main, then submits the next segment. A cancellation
    request wakes the active wait and sends ownership-bearing argument cleanup
    to main instead of resuming the callee.
    Initialized top-level locals and direct assignments survive those waits in
    one heap-owned invocation frame. Cleanup-bearing locals carry one liveness
    bit, move between segments without cloning, and are destroyed on main if
    cancellation wins. Consuming
    `await worker.cancel()` joins and destroys any other unclaimed result. If a
    synchronous main request is already running, it completes before its
    outcome is discarded. Parameter writes or unrelated ownership transfers,
    borrowed cleanup-bearing match subjects, suspending `for` loops, nested
    loops or matches inside a suspending `while`, `try await` and nested
    try-value normalization across a loop suspension, loop control or function
    exit followed by more work in the same synchronous segment, other
    suspending control flow nested
    inside another branch, dynamic delay expressions, combining a structured
    suspension with outer delays, non-tail suspended placement, and
    cross-executor loans remain the next native state-machine slices; Stage 0
    already implements the broader direct-call surface.

## Open questions

- How are executor values created, retained, and compared for current-context
  proof?
- Which cross-executor borrows can the unified loan checker prove safely?
- Which inferred Copy captures should diagnostics ask users to spell explicitly
  for clarity or ABI stability?
- What eventual child-task `out` contract remains sound across failure and
  cancellation?
- What is the final function-level isolation syntax?
- How should `.zd` represent callback-delivery executors beyond the existing
  caller/any invocation guarantee and main-isolated types/functions?
- Should any runtime-owned detached operation exist, and how must it report
  errors?
- How does the main executor integrate with application startup and shutdown?
- Which executor properties belong in FIIR: thread identity, seriality,
  reentrancy, destruction affinity, or actor-style isolation?

These questions are intentionally left open until implementation and the AppKit
pressure test provide evidence.
