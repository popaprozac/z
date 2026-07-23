# Z Notes

Z Notes is the native desktop composition test for Z. It is intentionally an
application rather than a collection of isolated compiler probes.

The application currently combines:

- an ARC-managed Z application model containing owned `Array<Note>` storage;
- `Option<usize>` selection and borrowed callback inspection;
- direct AppKit header import, an ARC-managed `NSWindow`, and a native
  `NSScrollView`/`NSTextView` note browser;
- direct `sqlite3.h` import with adjacent owned-output, null-only parameter,
  borrowed-text, and fixed-sentinel `.zd` contracts;
- explicit `target.link.libraries` configuration for `sqlite3`.

The application now uses the first `std/objc` target/action connection for an
interactive Add Note button plus editable title and body fields. The bound
connection owns the button and callback, so AppKit's weak target cannot silently
expire while the application is running. Startup loads
notes from `.z-cache/z-notes.sqlite3` and renders their titles and bodies into a
native scrollable view. Each click first persists the entered note, then
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
call, and is closed deterministically on every later exit. Prepared statements
use the same owned `out` shape with `sqlite3_finalize`.

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

`NoteStore.renderText()` borrows the store, iterates its owned `Array<Note>`
without moving any note, builds one owned UTF-8 value through `TextBuffer`, and
assigns it directly to `NSTextView.string`. The view is embedded in an imported
`NSScrollView` with no native wrapper. This intentionally remains a simple
read-only browser; replacing it with `NSTableView` should be the focused probe
for Z-defined Objective-C data-source and delegate conformance.

Next, this application should drive Objective-C protocol
conformance, table data-source/delegate methods, richer controls, escaping block
lifetime, background search through `thread.spawn`, cancellation, and
main-thread UI delivery.
