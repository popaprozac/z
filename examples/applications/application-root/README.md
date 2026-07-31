# Application lifetime root

This example uses a user-defined `Application`; Z does not provide or require
that type. It pressure-tests the generic mechanism a desktop framework can use
to publish one long-lived main-affine ARC identity.

Run it from the repository root:

```sh
bun run z run examples/applications/application-root/main.zs
```

Expected output:

```text
Z desktop revision=42
```

Read the source in this order:

1. [`application.zs`](application.zs) defines the ordinary main-affine class,
   keeps a statically empty `Once<Application>` private, and exposes narrow
   initialization and retrieval functions. The public initialization function
   returns the non-constructible `OnceLifetime<Application>` guard produced by
   the root.
2. [`status.zs`](status.zs) demonstrates that another module can retrieve the
   current identity when it has main-executor proof.
3. [`main.zs`](main.zs) constructs and publishes the application, retains the
   returned move-only lifetime guard, and asks a native worker to read the
   revision through `await on thread.main`.

`initializeApplication(...)` does not turn construction failure into a delayed
failure from `currentApplication`. Argument evaluation happens first. If a
throwing constructor or factory fails, the cell remains empty; `get()` itself
returns `Application` or traps when the lifetime invariant is violated. A named
class identity passed directly to `Once.initialize` transfers through `move`; a
temporary construction transfers directly. This example's public wrapper
receives an ordinary owned ARC parameter and moves that parameter's retained
reference into its private root, so the caller may keep its own class reference.

When `main` exits, `lifetime` deinitializes before the earlier `application`
binding. It removes the global root and releases that strong reference on the
main executor. No module deinitializer or arbitrary mutable global is involved.

## Next framework pressure-test sequence

This example deliberately proves only publication and main-affine lifetime. The
next slices remain separate so `Once<T>` does not silently become a
cross-thread access loophole:

1. **Opaque cross-thread transport.** `currentApplication()` should eventually
   retain and return the application identity from any thread without granting
   access to its main-isolated state. Carrying the identity does not hop
   executors or execute application code. The same slice must establish when
   `Mutex<T>` storage is shareable across native threads.
2. **Member-level executor restrictions.** Harmless metadata and explicitly
   synchronized methods may remain available off-main, while UI fields and
   methods continue to require `thread.main`. Diagnostics, hover, and completion
   must surface those member contracts; accessing a main-only member off-main
   is rejected until the caller uses explicit main placement.
3. **Zapp composition probe.** A small user-defined framework skeleton will
   combine the application root, mutex-protected framework state, background
   work, explicit main-thread UI delivery, and deterministic cleanup. `Zapp`
   remains an application/framework pressure test, not a built-in Z type.
