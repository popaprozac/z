# Swift callback-to-async projection

This example composes seven native boundaries:

1. Swift starts work on a global Dispatch queue.
2. Its generated Objective-C compatibility header exposes an escaping block.
3. An adjacent `.zd` contract proves that Swift may invoke that block on any
   thread and asserts `invoked once`.
4. `async completion;` synthesizes an infallible overload, while the expanded
   `async completion(value, error) { ... }` form projects a conventional
   nullable `NSError` callback into `Task<T, E>`.
5. Z uses `attempt await` to inspect both success and failure, then hops to the
   main executor for AppKit work.
6. A real Swift `@MainActor` class crosses the generated header, enters Z's
   foreign IR as `on thread.main`, and keeps that isolation on its synthesized
   awaitable overload. A dedicated Z worker explicitly enters main placement,
   suspends there while the Swift callback completes, then resumes on its
   original worker.
7. The raw callback overload retrieves a synchronized `Once<Application>` from
   Swift's global Dispatch queue, updates `Mutex` state, and submits structured
   publication to `thread.main`. Generated block invocation and ARC release
   adapters enter the runtime captured when Z registered the block.

Run it on macOS:

```sh
bun run z run examples/interop/swift/swift-task-scope
```

The expected output is:

```text
7
42
swift callback published 42 on main
```

The generated task frame remains alive until Swift invokes its exactly-once
completion, even when cancellation has already been requested. The raw
callback-taking overload remains available by supplying `completion:` explicitly.
`ZSwiftMainActorWorker.calculate` invokes its completion synchronously, proving
that callback-to-task projection is also safe when native code completes before
the imported call returns. Its Z call is accepted inside an explicit
`await on thread.main { select await ...; }` region; the same direct call from
an ordinary async function is a compile-time executor-affinity error. The outer
`await` joins the placement operation, while the inner `await` suspends the
Swift operation without losing main-executor proof.
The delayed second operation is cancelled after native work starts; Z waits for
Swift's callback before destroying the frame. The first line is the owned
`NSError.code` observed through `failure(error)`; the second is the successful
value delivered through the worker → main → worker round trip. The final line
comes from a user-authored block that entered Z from Swift's global queue,
retrieved the shared application root safely, and published through its joined
`TaskScope` operation on main.
