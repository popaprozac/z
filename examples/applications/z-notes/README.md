# Z Notes

Z Notes is the native desktop composition test for Z. It is intentionally an
application rather than a collection of isolated compiler probes.

The application currently combines:

- an ARC-managed Z application model containing owned `Array<Note>` storage;
- an ARC-managed `NoteDatabase` containing one persistent
  `sqlite.sqlite3` native owner;
- `Option<usize>` selection and borrowed callback inspection;
- direct AppKit header import, an ARC-managed `NSWindow`, and a native
  `NSScrollView`/`NSTableView` note browser;
- Z-defined `NSTableViewDataSource` and `NSTableViewDelegate` conformance,
  lowered through an Objective-C adapter owned by `objc.Binding`;
- direct `sqlite3.h` import with adjacent owned-output, null-only parameter,
  borrowed-text, fixed-sentinel, and typed native-status `.zd` contracts;
- explicit `target.link.libraries` configuration for `sqlite3`.

The application now uses the first `std/objc` target/action connection for an
interactive Add Note button plus editable title and body fields. The bound
connection owns the button and callback, so AppKit's weak target cannot silently
expire while the application is running. Startup opens
`.z-cache/z-notes.sqlite3` once, stores the handle in `NoteDatabase`, loads
notes through that owner, and renders their titles and bodies as native table
rows. Each click first persists the entered note, then
mutates the ARC-managed `NoteStore`, selects it, updates native AppKit labels
and the window title, refreshes the browser, and logs the new note. The
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
call, narrows to non-null, and moves into the
`private database: sqlite.sqlite3` field. The ARC-managed `NoteDatabase`
reuses that handle for schema creation, loading, and every insert. Its final
release calls `sqlite3_close` exactly once. Prepared statements remain
operation-local owners and use the same `out` shape with `sqlite3_finalize`.

The same declaration file projects SQLite's conventional zero-success integer
statuses into `void throws i32`. Application code uses `try sqlite3_open(...)`
and `try sqlite3_prepare_v2(...)`; a nonzero native return preserves the exact
SQLite status as the error value. An owned `out` handle becomes cleanup-active
immediately after the native call, before a failure is propagated, so a C API
that produces a handle alongside an error cannot leak it. `sqlite3_step`
deliberately remains a raw integer call because `SQLITE_ROW` and `SQLITE_DONE`
are useful non-error outcomes. Those object-like integer macros are imported
directly from `sqlite3.h` as typed `i32` constants rather than repeated as
application-owned magic numbers.

`sqlite3_prepare_v2` also has an optional `const char **` tail that this app
does not use. Its `pzTail: null` contract exposes only the native null value
rather than introducing a raw pointer. `sqlite3_column_text` returns a
`view cstring | null` tied to the prepared statement. Z requires a null check,
prevents statement finalization while the view is live, and `String.from`
copies the bytes into owned model storage. No C wrapper or generated binding
file sits between Z and SQLite.

Editable title and body fields cross from `NSString` into owned Z `String`
values. Inserts use SQLite placeholders rather than SQL interpolation. The
`sqlite3_bind_text` declaration keeps its real five-parameter C ABI and marks
the destructor parameter `{ fixed SQLITE_TRANSIENT; }`; Z calls supply four
arguments while generated C inserts the sentinel so SQLite copies the bytes.
Quotes and other ordinary user text therefore persist without an escaping
wrapper or application-written native glue.

`NotesTableController` is an ordinary ARC-managed Z class that names imported
AppKit protocols after `implements`. Its methods use `as "selector:"` to expose
native protocol selectors while retaining readable Z-local names. The compiler
validates each parameter and result against the SDK declaration, then emits an
`NSObject` adapter forwarding those selectors into the Z class.

`objc.bind(notesView, { dataSource: tableController, delegate:
tableController })` installs the adapter into AppKit's weak protocol properties.
The returned `objc.Binding` strongly owns the table, adapter, and Z controller;
keeping the token across `app.run()` prevents a helper-function refactor from
creating a dangling delegate.

Next, this application should drive richer controls, selection callbacks,
escaping block lifetime, background search through `thread.spawn`,
cancellation, and main-thread UI delivery.
