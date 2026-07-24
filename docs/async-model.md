# Async Model

Z keeps suspension explicit with TypeScript-shaped syntax:

```z
async function fetchUser(id: UserId): User throws NetworkError {
  return try await client.getUser(id);
}
```

Synchronous functions are freely callable from async code. A fallible async
operation is consumed with `try await` or retained with `attempt await`.
The synchronous `sleep` imported from `std/time` remains a blocking OS-thread
operation even inside async code. `await delay(milliseconds)` is the explicit
scheduler-aware alternative: it suspends the current task without blocking
other ready tasks.

```z
import { sleep, delay } from "std/time";

sleep(100);       // blocks the current OS thread
await delay(100); // suspends this task on a monotonic executor timer
```

An ordinary call inside an async function remains ordinary synchronous work:

```z
console.log("before"); // runs now on the executor thread
calculateLayout();     // does not yield
await delay(100);      // explicit suspension point
console.log("after");
```

Top-level Z functions, static and instance methods, parameter capabilities, the
blocking `sleep`, typed `console` formatting, and direct supported C++ calls
execute in source order inside the current native task-frame tier. These
synchronous calls block that executor thread until they return. A foreign API
becomes suspending only through an explicit async adapter; importing it never
silently changes its scheduling behavior.

An async call is valid only beneath `await` or `spawn`. Calling an async
function never silently starts detached work:

```z
const user = try await fetchUser(id); // sequential suspension
fetchUser(id);                        // error: requires await or spawn
```

`await fetchUser(id)` starts the operation as sequential work in the current
task. It may run synchronously until its first actual suspension. `spawn
fetchUser(id)` schedules a child immediately; the returned task is hot.
`await userTask` later joins that child, returning immediately if it has already
completed or suspending only the current task until it does. It does not block
the executor's OS thread.

Concurrency is explicit and structured. Every async function body is an
implicit root task scope, so common concurrent work needs no wrapper:

```z
async function loadDashboard(id: UserId): Dashboard throws NetworkError {
  const userTask = spawn fetchUser(id);
  const postsTask = spawn fetchPosts(id);

  return Dashboard({
    user: try await userTask,
    posts: try await postsTask,
  });
}
```

Children cannot outlive the async function that owns them. An explicit `async
scope` creates a narrower ownership region when a group of children must finish
before the rest of the function continues. A propagated failure cancels
still-live siblings and descendants, and task-frame locals are deterministically
destroyed before their owner finishes. Detached tasks require an explicit
program-owned supervisor.

```z
async function refresh(): void throws NetworkError {
  async scope {
    const cacheTask = spawn refreshCache();
    const sessionTask = spawn refreshSession();
    try await cacheTask;
    try await sessionTask;
  }

  // Both refresh tasks and their captured values are finished here.
  showRefreshedState();
}
```

`async function` permits suspension and its body owns root child tasks. `async
scope` introduces a narrower lexical region of concurrent child ownership. An
explicit scope therefore requires an async parent: leaving it implicitly joins
its children and may suspend. Returning from an async function likewise joins
or cancels its root children. `return` inside an explicit scope still exits the
enclosing function, but only after outstanding children are cancelled or
joined and their frames are cleaned up. A future synchronous bridge for
starting an async root will be an explicit blocking runtime API, not ordinary
`async scope` syntax.

`spawn` accepts exactly one direct async call in an async function and produces
a scope-bound `Task<T>` or `Task<T, E>`. The task's source-level success and
error types are the async function's declared `T throws E`; async functions do
not expose a Promise or Future wrapper in their signatures.

`await spawn operation()` is rejected as redundant. Sequential work uses
`await operation()`; concurrent work binds the spawned task and joins it after
the parent has had an opportunity to continue.

## Explicit native threads

Keyword `spawn` always inherits the current async executor. It never silently
changes an operation into CPU-parallel work. Starting a native OS thread is a
separate standard-library operation:

```z
import { thread } from "std/thread";

struct Calculation {
  value: i32;
  multiplier: i32;
}

function calculate(input: Calculation): i32 {
  return input.value * input.multiplier;
}

async function answer(input: Calculation): i32 {
  const calculation = thread.spawn(move () => calculate(input));
  doOtherWork();
  return await calculation;
}
```

`thread.spawn` is hot: it starts exactly one native thread at the call. Its
argument is a synchronous zero-parameter closure, not an async function, and
the returned `Task<T>` or `Task<T, E>` remains owned by the surrounding
structured task scope.
`await` joins it; leaving the scope with an unconsumed handle also joins it
before destroying the child frame. A capturing closure must use `move` so the
boundary visibly owns each input. Recursively cleanup-free values are Copy
values: the thread receives a private snapshot and the source remains usable.
Mutating such a capture changes only the thread's snapshot. A uniquely owned
value instead transfers its owner and the source binding becomes unavailable.

The intended fallible form preserves the ordinary typed-error channel:

```z
const calculation = thread.spawn(move (): i32 throws CalculationError => {
  const value = try calculate(input);
  if (value < 0) return 0;
  return value;
});
const value = try await calculation;
```

That closure produces `Task<i32, CalculationError>`; `attempt await` would
instead expose `Result<i32, CalculationError>`. Worker and parent error slots
track liveness explicitly. The ordinary thread-transfer classifier therefore
also applies to `E`: plain errors copy, unique String/Array/TextBuffer ownership
and containing aggregates move, deeply readonly classes use atomic ARC, and
contracted native owners move through placement storage. Observation,
propagation, cancellation, and discarded outcomes each destroy the payload
exactly once. No untyped thread-exception channel is used.

Inside the synchronous worker, `try` may directly initialize a binding or be
returned, while `attempt` may materialize a local `Result<T, E>` for matching.
Binding first keeps propagation and cleanup visible while nested `try`
expressions remain intentionally unsupported.

The first executable transfer rule is deliberately narrow. Integers, floats,
booleans, fixed arrays, and recursively cleanup-free Z structs/enums copy.
`Array<T>` and recursively supported Z aggregates containing it move when `T`
is itself transferable; owned Array-backed results move back to the awaiting
task. Owned `String` and mutable `TextBuffer` storage follow the same consuming
path. Because the thread closure is one-shot, it may inspect an owned String,
mutate a captured `let` TextBuffer, consume it with `finish()`, and return the
resulting String through `await`.

A deeply readonly Z class may also cross by shared identity. The compiler
recursively verifies its fields and methods, emits atomic strong ARC operations,
and retains a worker reference; the parent reference remains usable. Mutable
classes, borrowed `in`, `inout`, and `out` bindings, `view`, `Slice`, `Arena`,
weak references, and custom Z `deinit` remain rejected. A move-only C++ RAII
value or owned C handle may transfer when its adjacent `.zd` contract explicitly
declares `thread { transfer; deinit; }`; the source binding is consumed and the
worker frame performs native destruction or release. Uncontracted native owners
remain rejected because ordinary move/destruction capability does not establish
thread safety. Concurrent weak upgrade awaits a shared side-table protocol.
Atomic ARC protects reference lifetime only; mutable shared class state will
require actors, synchronization, or another explicit isolation contract.

The worker may call ordinary synchronous Z or supported native functions. It
cannot suspend or `await`. Awaiting or cancelling a running worker suspends only
the awaiting task: the FIFO executor remains free to poll unrelated tasks and
timers. Worker completion crosses into the executor through a synchronized
completion queue, which resumes the waiter on the executor thread before the
finished OS thread is joined. Registration and completion use the same lock so
a completion cannot be lost between checking the task and installing its
waiter.

Cancellation cannot forcibly interrupt synchronous native work. It records an
atomic cooperative request; the worker finishes its current synchronous call,
publishes completion, and its unclaimed outcome is discarded after the awaiting
task resumes. Future `pool.spawn` and multithreaded executors remain separate
designs; `thread.spawn` will continue to mean one explicit native thread rather
than silently becoming pooled work.

This keeps the existing Z error model intact: `try await` unwraps success and
propagates `E`, while `attempt await` materializes `Result<T, E>` for matching or
storage. Writing `Result<T, E>` as the async function's return type would force
manual outcome handling and, when combined with `throws E`, create two error
channels for one operation.

Cancellation is a structural task outcome distinct from `throws E`. It flows
from parents to children, unwinds task frames, and runs ordinary synchronous
`deinit` cleanup. Suspending or fallible cleanup remains an explicit async
operation such as `try await connection.close()`; `deinit` never suspends.
Cancellation is cooperative at poll boundaries: it cannot interrupt a blocking
synchronous or foreign call. A failure retained with `attempt await` is handled
as a `Result` value and therefore does not cancel sibling work. Cancelling a
task suspended on `delay` removes its pending timer before task-frame cleanup.
Caller-driven cancellation is an explicit consuming join:

```z
const task = spawn refresh();
await task.cancel();
// refresh and all descendant cleanup are finished here
```

`cancel()` returns `void`: it requests cancellation, joins the task, disposes an
unclaimed success value or domain error, and then lets the caller continue. If
the child completed before the request, the operation still joins and disposes
the outcome. The handle is unavailable afterward. Cancellation therefore stays
a structural outcome rather than being smuggled into `throws E` or used to
manufacture a `T`.

The first async ownership tier permits owned values, ARC class references,
owned closures, direct move-only native values, and whole Z value structs or
enums containing them in task frames. Non-default-constructible C++ storage
begins its lifetime through placement construction. Transfer uses a typed take
that move-constructs the destination, destroys the moved-from object, and clears
its live flag before raw frame storage is released. Task results use matching
storage and move through ordinary `return`, `return await`, and awaited local
bindings. Fallible native results propagate through `try await`; `attempt await`
placement-constructs `Result<T, E>` in named or hidden suspension storage, with
borrowed and consuming match lowering. These paths are exercised across normal
completion, consuming transfer, failure, cancellation, and destruction of
completed-but-unclaimed storage. Owned native arguments, including whole Z
value aggregates containing them, move into child-frame parameter storage when
`await` or `spawn` creates the task. Cancellation cleans those parameters even
when the child body has not been polled. Immutable `in` value/native parameters
borrow caller-frame storage across suspension. Direct await is intrinsically
bounded by its join. Spawned borrowing requires an explicit `async scope`, and
the owner cannot move or mutate until every borrowing child joins; multiple
immutable children may share it. Consuming a task through `await task` or `await
task.cancel()` releases that child's borrow immediately. ARC classes continue to
use owned parameters and task-frame retains. A direct-awaited `inout` call may
borrow mutable value/native storage from the caller frame. The caller is
suspended through the join, so the callee has exclusive access and may itself
suspend without copying the owner:

```z
async function refreshAfter(inout document: Document): void {
  await delay(10);
  document.refresh();
}

let document = Document({ revision: 41 });
await refreshAfter(inout document);
```

Spawned mutation uses the same pointer path inside an explicit scope. The owner
is inaccessible while the child holds its exclusive borrow, then becomes
available after an explicit consuming join or at scope exit:

```z
async scope {
  const task = spawn refreshAfter(inout document);
  doIndependentWork();
  await task;
  publish(document);
}
```

The bootstrap also merges task loans through `if` control flow. Each branch
starts with the same incoming loans, and the owner becomes available after the
merge only when every branch that can continue has consumed the task through a
join or cancellation:

```z
if (keepResult) {
  await task;
} else {
  await task.cancel();
}
publish(document);
```

A branch that returns or throws does not constrain the unreachable merge. If
even one continuing branch leaves the task live, the owner remains borrowed.
Loops remain conservative: a join inside a loop does not release the loan for
code outside that loop until loop-aware fixed-point merging is implemented.

Mutation is not rolled back if the task later throws or is cancelled. A
non-throwing direct await may also pass `out` storage:

```z
let reading: SensorReading;
await readSensorAfter(20, out reading);
```

The callee may suspend, but must initialize the output on every successful path
before the caller resumes. This first tier is cleanup-free; ownership-bearing
output needs a completion-time live-storage handoff.

`Slice<T>` uses the same loan model without copying its elements. The task frame
copies only the pointer/length descriptor. Direct await permits read-only or
`inout` access; spawn requires an explicit scope and holds a shared or exclusive
loan on the backing collection until join:

```z
async function calibrate(inout readings: Slice<i32>): void {
  await delay(1);
  readings[0] = readings[0] + 1;
}

let readings = [40, 41];
async scope {
  const task = spawn calibrate(inout readings);
  await task;
}
```

Executable backing storage includes fixed arrays and growable `Array<T>` owners,
including Z cleanup-bearing and move-only C++ element types. The task frame owns
the collection storage, destroys initialized elements in reverse order, and
releases it on ordinary completion, failure, or cancellation. A growable owner
cannot call `push` or otherwise reallocate while a child holds a Slice loan; an
explicit join or consuming cancellation releases the loan and permits growth
again. Spawned `out`, ARC-reference rebinding, borrowed struct receivers, and
other unrelated live borrows remain rejected. Cross-thread executors will
additionally require sendability before these pointer-backed borrows can leave
one thread.

Classes and structs may declare async methods. A class receiver is retained by
the task frame. A struct async instance method must initially declare `move
this`, transferring its value into the frame; static async methods on either
kind have no receiver restriction. `deinit` is never async.

Typed channels transfer ownership:

```z
const [sender, receiver] = Channel<Job>.bounded(64);
try await sender.send(job); // moves a non-copyable job
```

Actors provide isolation for long-lived mutable state; channels remain the
primitive for pipelines and explicit communication. Executors are pluggable so
Z can participate in Dispatch, GUI run loops, Windows thread-pool I/O, custom
engines, and deterministic tests.

## Bootstrap phases

Phase 0 implements parsing, static typing, ownership restrictions, diagnostics,
hover, completion, and highlighting for `async`, `await`, `try await`,
`attempt await`, `async scope`, `spawn`, inferred task handles, and the
`on thread.main`, `await on thread.main`, and `spawn on thread.main` placement
forms. `z check` accepts these programs. The executable placement tier lowers
blocks into structured task frames and supports recursively plain captures,
owned String copies, retained Z ARC classes, and Objective-C identities retained
by ARC when captured from the owning async task. Native workers publish main
children without blocking the main executor, and Darwin wakes an installed
`CFRunLoopSource`. Mutable and borrowed captures, explicit native/foreign
affinity contracts, and Windows/Linux UI-loop adapters remain; see
[`executor-placement.md`](executor-placement.md).

Phase 1 executes owned async functions and methods on a deterministic
single-thread FIFO executor. Each call allocates a typed task frame and each
`await` becomes an explicit poll state. Direct awaits suspend their parent;
`spawn` enqueues hot children and a task handle joins the already-running frame.
Scalars, enums with owned payloads, value structs, ARC class references,
growable arrays, and cleanup-bearing fixed arrays can live in task frames;
error values are currently cleanup-free. Growable arrays keep their native
pointer/length/capacity descriptor in the frame, and fixed arrays containing
non-trivial C++ values use aligned placement storage. Live flags make struct,
enum, and collection moves explicit, ARC copies retain,
awaited results transfer between frames, and active `Option<T>`/`Result<T, E>`
payloads are destroyed by tag. Frame destruction releases every value still
owned on success or propagated error. Task frames also lower `throw`, `try
await`, `attempt await`, payloadless `void` success, and root failure exit.
Move-only native Results use aligned placement storage and their generated
tagged-union destructor instead of plain aggregate assignment. `z
emit` produces readable C for this subset and `z run` executes it.
Immutable parameters and direct-awaited mutable or cleanup-free output
parameters use pointers into a stable suspended caller frame and are never
destroyed by the child frame.
Unsupported but valid async shapes report `Z0700` with a specific boundary
diagnostic.

Class method frames retain `this`; consuming struct methods move `this`; static
async methods carry no receiver. Function exit implicitly joins unacknowledged
non-throwing root children, while throwing children require an explicit `try
await` or `attempt await`. Nested explicit scopes now join and destroy their
directly owned children at each lexical closing brace. Scope-local task handles
are executable; other scope-local frame values remain diagnosed until their
brace-local cleanup states land. Propagated failures now request structural
cancellation of live siblings and descendants, redirecting their state machines
through deterministic child and frame cleanup before failure completes. The
executor now maintains a sorted monotonic timer queue for direct `await
delay(...)`; it wakes expired tasks in deadline order and blocks the OS thread
only when the ready queue is empty. Synchronous Z calls, receiver methods,
capability-aware arguments, and typed console output lower between suspension
states without yielding. Concise synchronous `match` expressions over
cleanup-free enum subjects and results lower atomically in a poll state, with
payload bindings, plain-data object destructuring, and checked integer
arithmetic. Embedded awaits with cleanup-free results normalize into hidden
task-frame slots. Their calls run once in left-to-right order, including awaits
inside ordinary call arguments or another awaited call, and awaited `if`
conditions resume through explicit branch states. Inline `match (attempt await
operation())` therefore needs no source-level temporary. Consuming matches move
their enum subject into hidden live-tracked frame storage. Whole payload
bindings own the selected payload; object-pattern fields borrow the hidden
payload. A selected value-producing arm may run synchronous statements and
suspend before its final expression or `select`, while `return`, `throw`,
propagation, loop control, and cancellation retain exact cleanup.
Selected results may own ARC identity, strings, Z values with `deinit`, or
move-only native storage. A direct owned `await` in the selected arm transfers
its hidden suspension slot into the result before cleaning the arm. Lazy
suspension under short-circuit operators, ternaries, and value-producing `if`
remains diagnosed until branch-aware expression lowering preserves
selected-branch evaluation. The next Phase 1 layers add broader foreign-call
shapes and brace-local value cleanup.
Later phases
add channels, sendability and atomic ARC, native executors, actors, and
callback-to-async synthesis. Async-free programs never link the runtime.
