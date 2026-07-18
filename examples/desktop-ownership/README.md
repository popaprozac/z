# Desktop ownership probe

This example combines a small owned application model with real AppKit objects:

```sh
bun run z run examples/desktop-ownership/main.z
```

The `Workspace` is an ARC-managed Z class. Its `Array<Document>` owns move-only
value records containing Z strings, `open(inout this, ...)` makes mutation
visible, and borrowed methods can inspect the model without copying it. A Z
`WindowController` stores both the imported `AppKit.NSWindow` nominal type and
the owned `Workspace`; Objective-C ARC keeps the native window alive. Its first
log line streams before AppKit enters the event loop, while the window is open.

This is intentionally the first pressure probe, not a complete application.
The companion ownership pressure log records the concrete language and interop
walls encountered while extending it.
