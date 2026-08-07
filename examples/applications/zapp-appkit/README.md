# Zapp AppKit composition probe

This macOS-only example takes the portable `zapp-skeleton` architecture across
a real native boundary. Its user-authored `Application` stores `NSWindow` and
`NSTextField` identities while keeping worker state behind `Mutex<T>`.

Run it from the repository root:

```sh
bun run z run examples/applications/zapp-appkit
```

A native window remains visible while a dedicated worker performs background work. The
worker retrieves the shared `Application` through `Once<Application>`, updates
only its mutex-protected state, and then executes:

```z
await on thread.main publishApplicationStatus(ticket);
```

The window title and label are updated by that placed call. After a short
visible interval, the same worker places `closeApplication()` onto main; that
call closes the window. An `NSWindowWillCloseNotification` observer stops the
real `NSApplication.run()` loop from inside AppKit event dispatch and posts an
application-defined wake event so `run()` returns deterministically. Expected
terminal output:

```text
worker completed AppKit job 1
published AppKit job 1 on main
worker resumed after publishing AppKit job 1
closing AppKit window on main
Zapp completed AppKit job 1
```

The example is intentionally not a built-in framework. It proves that ordinary
Z code can build a framework-level application root whose synchronized model
surface is available to workers while AppKit identity stays main-executor
bound.

AppKit construction currently lives in the synchronous, main-bound
`createApplication()` helper. Direct imported Objective-C expressions inside
an async frame remain outside the current executable async lowering subset; the
helper does not weaken or hide the executor contract.
