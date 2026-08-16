# Message router

This application pressure-tests function values as ordinary ARC-managed values
inside a long-lived `Router` class. The router owns a `Map<String, Handler>` and
offers ordinary registration plus typed throwing dispatch methods. A route can
be a direct function value or an owned capturing closure. Insertion retains the
handler, lookup returns an independently retained `Option<Handler>`, and the
router releases every stored handler when its own ARC lifetime ends.

```sh
bun run z run examples/applications/message-router/main.zs
```

Expected output:

```text
increment=42 offset=42 missing=missing
released route state 20
```

The companion native-callback entry sends a checked C callback through the
same Z-owned router:

```sh
bun run z run examples/applications/message-router/native-callback.zs
```

Here the adjacent `callbacks.h.zd` contract gives the C callback an owned,
escaping closure environment and records that lib calls it on the registering
thread. The closure retains the `Router`; the router retains its handler; and
`clearRetainedOperation()` releases the foreign callback root. Expected output:

```text
released native route state 20
native callback routed=42
```
