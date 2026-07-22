# Z Notes

Z Notes is the native desktop composition test for Z. It is intentionally an
application rather than a collection of isolated compiler probes.

The application currently combines:

- an ARC-managed Z application model containing owned `Array<Note>` storage;
- `Option<usize>` selection and borrowed callback inspection;
- direct AppKit header import and an ARC-managed `NSWindow`;
- direct `sqlite3.h` import with adjacent owned-output, null-only parameter,
  and borrowed-text `.zd` contracts;
- explicit `target.link.libraries` configuration for `sqlite3`.

The application now uses the first `std/objc` target/action adapter for an
interactive Add Note button. Startup loads notes from
`.z-cache/z-notes.sqlite3`. Each click first persists a generated note, then
mutates the ARC-managed `NoteStore`, selects it, updates native AppKit labels
and the window title, and logs the new note. The
window, controls, methods, properties, strings, and layouts still come directly
from `AppKit/AppKit.h`; `std/objc` appears only where AppKit requires a target
object plus selector instead of a typed block or ordinary method call.

Run the non-GUI model/link smoke test with:

```sh
bun run z run examples/applications/z-notes/smoke.zs
```

Run the headless create/insert/reload persistence path with:

```sh
bun run z run examples/applications/z-notes/persistence-smoke.zs
```

Open the native application with:

```sh
bun run z run examples/applications/z-notes/main.zs
```

Today `bun` launches the stage-0 TypeScript driver. The driver resolves Z
modules and native headers, emits Objective-C ARC into `.z-cache/main.m`, asks
Clang to build `.z-cache/main`, and then executes that native binary. Bun is not
the application runtime and is not involved after the executable starts.

The project targets macOS 14 because `NSApplication.activate()` was introduced
there. Setting a lower `target.minimumVersion` produces a diagnostic at the Z
call site with the SDK declaration as a secondary location.

## Persistence and native views

The application does not hide the current SQLite ownership boundary behind a
handwritten C wrapper. `sqlite3_open` produces an owned handle through
`sqlite3 **`; `sqlite3.h.zd` classifies that parameter as an owned nullable
`out` value whose deinitializer is `sqlite3_close`. A local `let database;`
therefore acquires its native type from the call, becomes initialized after the
call, and is closed deterministically on every later exit. Prepared statements
use the same owned `out` shape with `sqlite3_finalize`.

`sqlite3_prepare_v2` also has an optional `const char **` tail that this app
does not use. Its `pzTail: null` contract exposes only the native null value
rather than introducing a raw pointer. `sqlite3_column_text` returns a
`view cstring | null` tied to the prepared statement. Z requires a null check,
prevents statement finalization while the view is live, and `String.from`
copies the bytes into owned model storage. No C wrapper or generated binding
file sits between Z and SQLite.

The generated Add Note text is deliberately fixed and SQL-safe in this slice.
Editable user text should arrive with a length-aware transient SQLite binding
contract rather than interpolating arbitrary input into SQL.

Next, this application should drive Objective-C protocol
conformance, table data-source/delegate methods, richer controls, escaping block
lifetime, background search through `thread.spawn`, cancellation, and
main-thread UI delivery.
