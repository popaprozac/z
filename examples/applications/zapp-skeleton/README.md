# Zapp framework skeleton

This is a composition probe for a future user-authored desktop framework. Z
does not provide `Application` or `Zapp`; every framework type and function in
this directory is ordinary application code built from general language and
standard-library features.

Run it from the repository root:

```sh
bun run z run examples/applications/zapp-skeleton/main.zs
```

Expected output:

```text
Zapp: Ready after background job 1
```

The example combines the four framework foundations:

1. `Once<Application>` publishes one long-lived identity and
   `currentApplication()` retrieves it from any Z-managed thread.
2. `Mutex<RuntimeState>` makes selected state readable and writable from a
   worker without making the whole class freely mutable.
3. `status: String on thread.main` makes presentation and lifecycle
   main-bound. The worker cannot read or write it directly.
4. `thread.spawn(async ...)` performs blocking native work on a dedicated
   worker, then `try await on thread.main publishApplicationStatus(ticket)`
   explicitly delivers it to the UI executor. The async callee suspends through
   `await delay(1)` without occupying main, resumes its application update on
   main, and carries an owned `String` or typed status failure back through
   `Task<String, i32>`. The fixed-point backend also supports multiple such
   top-level literal delays separated by synchronous main-thread expressions;
   locals that must survive a delay remain deliberately fail-closed until task
   frames own their storage.

The move-only `OnceLifetime<Application>` remains owned by `main`, so the
published root is removed deterministically after all structured work joins.
Atomic affine ARC and executor-routed final release keep `Application.deinit`
on main even though workers temporarily retain the identity.

This program uses a Z-created worker. A foreign-created thread enters Z through
a checked `.zd` `thread any` callback or a generated embedding-runtime entry;
that bounded entry restores runtime ownership but does not turn the foreign
thread into a Z executor. See
[`foreign-thread-application-root.zs`](../../async/foreign-thread-application-root.zs)
and [`z-runtime-export`](../../interop/c/z-runtime-export) for those two shapes.
Real platform windows, webviews, IPC, assets, packaging, and plugin APIs belong
to the eventual framework rather than this language pressure test.
