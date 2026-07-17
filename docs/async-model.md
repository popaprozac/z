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

Concurrency is explicit and structured:

```z
async scope {
  const userTask = spawn fetchUser(id);
  const postsTask = spawn fetchPosts(id);

  return Dashboard({
    user: try await userTask,
    posts: try await postsTask,
  });
}
```

Children cannot outlive their scope. Failure cancels siblings and all task-frame
locals are deterministically destroyed before the scope exits. Detached tasks
require an explicit program-owned supervisor.

`spawn` accepts exactly one direct async call and produces a scope-bound
`Task<T>` or `Task<T, E>`. The task's source-level success and error types are
the async function's declared `T throws E`; async functions do not expose a
Promise or Future wrapper in their signatures.

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
accepts these programs; `z emit` and `z run` report `Z0700` until executable
lowering lands.

Phase 1 lowers async functions to stackless state machines and supplies a
deterministic single-thread executor. Later phases add structured cancellation,
scheduler-aware delay, channels, sendability and atomic ARC, native executors,
actors, and callback-to-async synthesis. Async-free programs never link the
runtime.
