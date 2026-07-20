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
The runtime uses cancellation requests internally for structured propagation;
there is no public caller-driven task-cancellation operation yet. Its eventual
request-and-join behavior must preserve cancellation as a third structural
outcome rather than smuggling it into `throws E` or manufacturing a `T`.

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
the owner cannot move or mutate until that scope joins its children; multiple
immutable children may share it. The bootstrap conservatively keeps the borrow
live until scope exit even after an explicit early join. ARC classes continue to
use owned parameters and task-frame retains. Z still rejects `inout`, `out`,
`Slice<T>`, borrowed struct receivers, and other unrelated live borrows at an
`await`. Cross-thread executors will additionally require sendability before
these pointer-backed borrows can leave one thread.

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
`attempt await`, `async scope`, `spawn`, and inferred task handles. `z check`
accepts these programs.

Phase 1 executes owned async functions and methods on a deterministic
single-thread FIFO executor. Each call allocates a typed task frame and each
`await` becomes an explicit poll state. Direct awaits suspend their parent;
`spawn` enqueues hot children and a task handle joins the already-running frame.
Scalars, enums with owned payloads, value structs, and ARC class references can
be parameters, locals, and success values; error values are currently
cleanup-free. Live flags make struct and enum moves explicit, ARC copies retain,
awaited results transfer between frames, and active `Option<T>`/`Result<T, E>`
payloads are destroyed by tag. Frame destruction releases every value still
owned on success or propagated error. Task frames also lower `throw`, `try
await`, `attempt await`, payloadless `void` success, and root failure exit.
Move-only native Results use aligned placement storage and their generated
tagged-union destructor instead of plain aggregate assignment. `z
emit` produces readable C for this subset and `z run` executes it.
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
operation())` therefore needs no source-level temporary. Lazy suspension under
short-circuit operators, ternaries, value-producing `if`, and match arms is
diagnosed until branch-aware expression lowering can preserve selected-branch
evaluation. The next Phase 1 layers add owned hidden-result and match-payload
transfer, block and suspending arms, direct foreign calls, and brace-local value
cleanup. Later phases
add channels, sendability and atomic ARC, native executors, actors, and
callback-to-async synthesis. Async-free programs never link the runtime.
