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

1. [`application.zs`](application.zs) defines a mixed-affinity class, keeps a
   statically empty `Once<Application>` private, and exposes narrow
   initialization and retrieval functions. Its mutex-backed state is usable
   anywhere while `windowId` remains main-only. The public initialization
   function returns the non-constructible `OnceLifetime<Application>` guard.
2. [`status.zs`](status.zs) demonstrates that another module can retrieve the
   current identity and use its unrestricted synchronized method.
3. [`main.zs`](main.zs) constructs and publishes the application, retains the
   returned move-only lifetime guard, and asks a native worker to retrieve the
   identity and read its revision directly.

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

`get()` is synchronized across Z-managed threads, but it does not erase
executor contracts. A wholly `on thread.main` class is opaque on a worker until
explicit main placement. This mixed class exposes only its readonly thread-safe
and mutex-backed surface there; `current.windowId` and
`current.currentWindowId()` still require main proof. ARC retain is atomic, and
when the worker releases its handle the final cleanup is queued back to the
owning executor. Foreign-created threads must enter through a checked `thread
any` callback or generated embedding-runtime boundary; bounded runtime entry
does not make them executors or grant main-thread access.

The next framework pressure test is a small user-defined Zapp skeleton that
combines this root, mutex-protected framework state, background work, explicit
main-thread UI delivery, and deterministic cleanup. `Zapp` remains an
application/framework customer of Z, not a built-in language type.
