# Message router

This application pressure-tests function values as ordinary ARC-managed values
inside a long-lived router. Setup uses a uniquely owned mutable
`RouteRegistry`; `finish(move this)` consumes that builder and transfers its
sole owned Map into a deeply readonly `Router`. Registration is therefore
impossible after publication, and the resulting router can be shared across
threads because every `Handler` is declared `on thread.any`.

A route can be a direct function value or an owned capturing closure. Insertion
retains the handler, lookup returns an independently retained `Option<Handler>`,
and the router releases every stored handler when its own ARC lifetime ends.

```sh
bun run z run examples/applications/message-router/main.zs
```

Expected output:

```text
increment=42 offset=42 missing=missing
```

The companion native-callback entry sends a checked C callback through the
same Z-owned router:

```sh
bun run z run examples/applications/message-router/native-callback.zs
```

Here the adjacent `callbacks.h.zd` contract gives the C callback an owned,
escaping closure environment and records that the library calls it on the registering
thread. The closure retains the `Router`; the router retains its handler; and
`clearRetainedOperation()` releases the foreign callback root. Expected output:

```text
native callback routed=42
```
