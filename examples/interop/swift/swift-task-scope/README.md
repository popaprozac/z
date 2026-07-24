# Swift background callback through `TaskScope`

This example composes four native boundaries:

1. Swift starts work on a global Dispatch queue.
2. Its generated Objective-C compatibility header exposes an escaping block.
3. An adjacent `.zd` contract proves that Swift may invoke that block on any
   thread.
4. The callback submits a synchronous AppKit operation through the named
   `TaskScope`, which joins it on the main executor before scope exit.

Run it on macOS:

```sh
bun run z run examples/interop/swift/swift-task-scope/main.zs
```

The expected output is:

```text
Swift background result=42
```

`waitForCompletion` keeps the foreign producer alive until it has attempted
submission. It does not execute the AppKit operation. Scope exit performs the
structured join, and the Darwin executor asserts that the operation runs on the
process main thread.
