# Swift callback-to-async projection

This example composes five native boundaries:

1. Swift starts work on a global Dispatch queue.
2. Its generated Objective-C compatibility header exposes an escaping block.
3. An adjacent `.zd` contract proves that Swift may invoke that block on any
   thread.
4. `async completion;` synthesizes an overload that hides the callback and
   produces a Z task result.
5. Z awaits that result and then hops to the main executor for AppKit work.

Run it on macOS:

```sh
bun run z run examples/interop/swift/swift-task-scope/main.zs
```

The expected output is:

```text
42
```

The generated task frame remains alive until Swift invokes its exactly-once
completion, even when cancellation has already been requested. The raw
callback-taking overload remains available by supplying `completion:` explicitly.
The delayed second operation is cancelled after native work starts; Z waits for
Swift's callback before destroying the frame.
