# Message router

This application pressure-tests function values as ordinary ARC-managed values
inside `Map`. A route can be a direct function value or an owned capturing
closure. Insertion retains the handler, lookup returns an independently retained
`Option<Handler>`, and removal transfers the map's retained handle.

```sh
bun run z run examples/applications/message-router/main.zs
```

Expected output:

```text
increment=42 offset=42 missing=missing
released route state 20
```
