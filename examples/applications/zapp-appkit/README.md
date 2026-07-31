# Zapp AppKit composition probe

This macOS-only example takes the portable `zapp-skeleton` architecture across
a real native boundary. Its user-authored `Application` stores `NSWindow` and
`NSTextField` identities while keeping worker state behind `Mutex<T>`.

Run it from the repository root:

```sh
bun run z run examples/applications/zapp-appkit
```

A native window appears while a dedicated worker performs background work. The
worker retrieves the shared `Application` through `Once<Application>`, updates
only its mutex-protected state, and then executes:

```z
await on thread.main publishApplicationStatus(ticket);
```

The window title and label are updated by that placed call. The main task then
closes the window and exits. Expected terminal output:

```text
Zapp completed AppKit job 1
```

The example is intentionally not a built-in framework. It proves that ordinary
Z code can build a framework-level application root whose synchronized model
surface is available to workers while AppKit identity stays main-executor
bound.

AppKit construction currently lives in the synchronous, main-bound
`createApplication()` helper. Direct imported Objective-C expressions inside
an async frame remain a known Phase 1 lowering boundary; the helper does not
weaken or hide the executor contract.
