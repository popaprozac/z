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
