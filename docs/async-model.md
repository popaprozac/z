# Eventual Async Model

Z aims for explicit suspension with minimal coloring:

```z
async function fetchUser(id: UserId): User throws NetworkError {
  return try await client.getUser(id);
}
```

Synchronous functions are freely callable from async code. A fallible async
operation is consumed with `try await` or retained with `attempt await`.
The synchronous `sleep` imported from `std/time` remains a blocking OS-thread
operation even inside async code. Eventual scheduler-aware delay will be a
distinct suspending API.

Concurrency is explicit and structured:

```z
async scope {
  const userTask = spawn fetchUser(id);
  const postsTask = spawn fetchPosts(id);

  return Dashboard {
    user: try await userTask,
    posts: try await postsTask,
  };
}
```

Children cannot outlive their scope. Failure cancels siblings and all task-frame
locals are deterministically destroyed before the scope exits. Detached tasks
require an explicit program-owned supervisor.

Typed channels transfer ownership:

```z
const [sender, receiver] = Channel<Job>.bounded(64);
try await sender.send(job); // moves a non-copyable job
```

Actors provide isolation for long-lived mutable state; channels remain the
primitive for pipelines and explicit communication. Executors are pluggable so
Z can participate in Dispatch, GUI run loops, Windows thread-pool I/O, custom
engines, and deterministic tests.
