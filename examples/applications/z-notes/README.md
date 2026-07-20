# Z Notes

Z Notes is the native desktop composition test for Z. It is intentionally an
application rather than a collection of isolated compiler probes.

The first skeleton already combines:

- an ARC-managed Z application model containing owned `Array<Note>` storage;
- `Option<usize>` selection and borrowed callback inspection;
- direct AppKit header import and an ARC-managed `NSWindow`;
- direct `sqlite3.h` import with an adjacent owned-output `.zd` contract;
- explicit `target.link.libraries` configuration for `sqlite3`.

Run the non-GUI model/link smoke test with:

```sh
bun run z run examples/applications/z-notes/smoke.z
```

Open the native application with:

```sh
bun run z run examples/applications/z-notes/main.z
```

The project targets macOS 14 because `NSApplication.activate()` was introduced
there. Setting a lower `target.minimumVersion` produces a diagnostic at the Z
call site with the SDK declaration as a secondary location.

## Current persistence seam

The application does not hide the current SQLite ownership boundary behind a
handwritten C wrapper. `sqlite3_open` produces an owned handle through
`sqlite3 **`; `sqlite3.h.zd` classifies that parameter as an owned nullable
`out` value whose deinitializer is `sqlite3_close`. A local `let database;`
therefore acquires its native type from the call, becomes initialized after the
call, and is closed deterministically on every later exit. The smoke entry
proves this with an in-memory database. Schema creation and note loading are the
next persistence layer.

After persistence, this application should drive Objective-C protocol
conformance, table data-source/delegate methods, target/action, escaping block
lifetime, background search through `thread.spawn`, cancellation, and
main-thread UI delivery.
