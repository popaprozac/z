# Z Notes

Z Notes is the native desktop composition test for Z. It is intentionally an
application rather than a collection of isolated compiler probes.

The first skeleton already combines:

- an ARC-managed Z application model containing owned `Array<Note>` storage;
- `Option<usize>` selection and borrowed callback inspection;
- direct AppKit header import and an ARC-managed `NSWindow`;
- direct `sqlite3.h` import;
- explicit `target.link.libraries` configuration for `sqlite3`.

Run the non-GUI model/link smoke test with:

```sh
bun run z run examples/applications/z-notes/smoke.z
```

Open the native application with:

```sh
bun run z run examples/applications/z-notes/main.z
```

## Next pressure seam

The application does not hide the current SQLite ownership boundary behind a
handwritten C wrapper. `sqlite3_open` produces an owned handle through
`sqlite3 **`, while the current foreign-interface contract tier models owned
single-pointer returns. The next interop slice should make that out-produced
ownership explicit and deterministic, then replace the version-only probe with
schema creation and note loading.

After persistence, this application should drive Objective-C protocol
conformance, table data-source/delegate methods, target/action, escaping block
lifetime, background search through `thread.spawn`, cancellation, and
main-thread UI delivery.
