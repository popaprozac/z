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
operation even inside async code. Scheduler-aware delay will be a distinct
suspending API.

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
before the rest of the function continues. Failure cancels siblings and all
task-frame locals are deterministically destroyed before the owning scope
exits. Detached tasks require an explicit program-owned supervisor.

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

The first async ownership tier permits owned values, ARC class references, and
owned closures in task frames. It rejects `in`, `inout`, `out`, `Slice<T>`, and
borrowed struct receivers in async signatures, and rejects any other live
borrow at an `await`. Scoped async borrowing can be added later from real
zero-copy APIs without exposing general lifetime syntax.

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

Phase 1 executes top-level owned async functions and direct sequential awaits.
Each call allocates a typed task frame, each `await` becomes an explicit poll
state, and async `main` runs through a deterministic single-thread root runner.
Scalars, enums with owned payloads, value structs, and ARC class references can
be parameters, locals, and success values; error values are currently
cleanup-free. Live flags make struct and enum moves explicit, ARC copies retain,
awaited results transfer between frames, and active `Option<T>`/`Result<T, E>`
payloads are destroyed by tag. Frame destruction releases every value still
owned on success or propagated error. Task frames also lower `throw`, `try
await`, `attempt await`, payloadless `void` success, and root failure exit. `z
emit` produces readable C for this subset and `z run` executes it.
Unsupported but valid async shapes report `Z0700` with a specific boundary
diagnostic.

The next Phase 1 layers add receiver-aware method frames, a ready queue,
`spawn`, nested scope join/cancellation, and scheduler-aware delay. Later phases
add channels, sendability and atomic ARC, native executors, actors, and
callback-to-async synthesis. Async-free programs never link the runtime.
