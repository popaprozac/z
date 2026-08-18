# Zapp AppKit composition probe

This macOS-only example takes the portable `zapp-skeleton` architecture across
a real native boundary. Its user-authored `Application` stores `NSWindow`,
`NSTextField`, and `NSButton` identities while keeping worker state behind
`Mutex<T>`.

The same example now builds its message table through a mutable
`RouteRegistry`, consumes that setup value into a deeply readonly `Router`,
and stores the published router on `Application`. The AppKit callback and the
native worker both dispatch through that one immutable table. One worker route
also throws a typed `RouteError`; `attempt` proves the error remains ordinary Z
control flow even when the table is shared across executors.

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

The application root also owns an `objc.Connection` for the button's
target/action lifetime. That connection owns a Z closure, while the application
and closure share a reusable readonly `Router` whose immutable Map stores only
`on thread.any` handlers. The deterministic
smoke path clicks the button after `Once<Application>` is initialized, so the
native callback enters Z, dispatches `Message({ operation: "appkit-action" })`,
retrieves the current application, and publishes the routed result on main.
Nothing depends on the stack frame surrounding `NSApplication.run()` to keep
the target alive. Routed-action state is distinct from background-job
completion, so clicking before shutdown cannot change the program's success
status.

The window title and label are updated by that placed call. After a short
visible interval, the same worker places `closeApplication()` onto main; that
call closes the window. An `NSWindowWillCloseNotification` observer stops the
real `NSApplication.run()` loop from inside AppKit event dispatch and posts an
application-defined wake event so `run()` returns deterministically. Expected
terminal output:

```text
published AppKit job 42 on main
routed AppKit action 42 on main
worker completed AppKit job 1
published AppKit job 1 on main
worker resumed after publishing AppKit job 1
closing AppKit window on main
Zapp completed AppKit job 1
```

The example is intentionally not a built-in framework. It proves that ordinary
Z code can build a framework-level application root whose synchronized model
surface is available to workers while AppKit identity and callback lifetimes
stay main-executor bound.

`Application`, `RouteRegistry`, `Router`, and these route names are all example
code. Z contributes only the general-purpose ownership, readonly publication,
typed-error, synchronization, executor, closure, and native-interop features
used to build them.

AppKit construction currently lives in the synchronous, main-bound
`createApplication()` helper. Direct imported Objective-C expressions inside
an async frame remain outside the current executable async lowering subset; the
helper does not weaken or hide the executor contract.
