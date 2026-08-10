# Z Notes

Z Notes is the native desktop composition test for Z. It is intentionally an
application rather than a collection of isolated compiler probes.

The application currently combines:

- an ARC-managed Z application model containing owned `Array<Note>` storage;
- an ARC-managed `NoteDatabase` containing a persistent
  `sqlite.sqlite3` native owner, pressure-testing long-lived native storage;
- async startup loading on one dedicated `thread.spawn` worker, including a
  private worker executor, scheduler suspension, a worker-local SQLite owner,
  owned `Array<Note>` transfer, typed failure, and `await on thread.main`
  delivery;
- opaque transfer of a main-isolated Z presenter through the background save
  worker, with access and eventual release proven back on `thread.main`;
- per-save `TaskControl` storage in the main-isolated presenter, with an
  interactive Cancel Save action while the owning `TaskScope` retains join
  responsibility;
- `Option<usize>` selection and borrowed callback inspection;
- direct AppKit header import, an ARC-managed `NSWindow`, and a native
  `NSScrollView`/`NSTableView` note browser;
- Z-defined `NSTableViewDataSource` and `NSTableViewDelegate` conformance,
  lowered through an Objective-C adapter owned by `objc.Binding`;
- direct `sqlite3.h` import with adjacent owned-output, null-only parameter,
  owner-tied borrowed-text, view-invalidation, fixed-sentinel, and typed
  native-status `.zd` contracts;
- explicit `target.link.libraries` configuration for `sqlite3`.

The application uses `std/objc` target/action for an interactive Add Note
button plus editable title and body fields. The bound connection owns the
button and callback, so AppKit's weak target cannot silently expire while the
application is running.

The AppKit helpers are explicitly declared `on thread.main`. Z imports explicit
Clang `@UIActor` metadata when present and supplements AppKit's incompletely
annotated Objective-C headers with reviewed compiler API notes. As a result,
`NSApplication`, `NSWindow`, view/control identities, and Z aggregates storing
them carry main-executor affinity in hover and fail during Z analysis if moved
into an ordinary helper or native worker.

Startup deliberately uses two ownership domains. The main task opens one
persistent `NoteDatabase` to prove long-lived native-owner storage. It then starts
`thread.spawn(async move () => ...)` with an owned path snapshot. The dedicated
worker suspends once through scheduler-aware `delay`, opens a second
worker-local database, creates/seeds/loads the table, closes that handle on the
worker, and transfers only owned `Array<Note>` model data back through
`Task<Array<Note>, i32>`. No mutable ARC database or raw SQLite handle crosses
threads. The main task materializes that result into `NoteStore`, then
`await on thread.main` enters the synchronous AppKit lifetime. Interactive
saves deliberately open a worker-local `NoteDatabase`; the long-lived main
instance is not used for those calls. Each successful save then
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

Run the headless async worker/SQLite/owned-result path with:

```sh
bun run z run examples/applications/z-notes/background-load-smoke.zs
```

Open the native application with:

```sh
bun run z run examples/applications/z-notes
```

The directory form selects `target.entry` from `z.json`. Passing a smoke
`.zs` file explicitly overrides only the entry while retaining the same macOS
deployment and SQLite link configuration.

Today `bun` launches the Stage-0 TypeScript driver. The driver resolves Z
modules and native headers, emits Objective-C ARC into the project's
`.z-cache/run` cache, asks Clang to build the cached native executable, and then
executes it. Bun is not the application runtime and is not involved after the
executable starts.

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
`private database: sqlite.sqlite3` field. Each ARC-managed `NoteDatabase`
reuses its handle within one ownership domain. Worker-local instances perform
startup loading and interactive inserts; the long-lived main instance proves
storage and cleanup but currently performs no interactive query. Each final
release calls `sqlite3_close` exactly once on the thread that created and used
that instance. Prepared statements remain operation-local owners and use the
same `out` shape with `sqlite3_finalize`.

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

The controller implements both row rendering and
`tableViewSelectionDidChange:`. Selecting a native table row converts AppKit's
signed `NSInteger` index into Z's `usize` with explicit checked
`usize(row)` construction, updates `Option<usize>` application state, and
refreshes the selected-note label.

The app also records two current bootstrap boundaries honestly. Throwing
user-defined constructors are called through synchronous helpers rather than
directly inside async frames, and the long-lived `objc.connect` closure remains
inside the synchronous AppKit lifetime function. It now captures a
main-task-owned `TaskScope`: each button action snapshots the note into owned Z
values and schedules an explicitly async root on `thread.main`. That root moves
the snapshot into a dedicated worker, opens and closes its own SQLite handle,
and reports completion after resuming on main. The button callback returns
immediately, and `main` closes the scope after `app.run()` so every accepted
save is joined before shutdown. The source names `saveStatus` directly in the
innermost worker placement; capture analysis automatically forwards it through
the Objective-C action, scheduled async root, and worker without relay aliases.

The UI applies an accepted note optimistically on the main thread. A
`SaveStatusPresenter on thread.main` owns the status label and an
`Option<TaskControl>` for the active save. The Cancel Save button synchronously
requests cancellation through that non-joining control; the main task's
`TaskScope` still joins the save and its worker before shutdown. The worker may
carry that ARC identity only as an opaque capability: it cannot inspect,
alias, return, retain, or release the presenter on the worker. Its nested
`await on thread.main` region may call `persisted`, and worker teardown queues
the transferred retain's release to the main executor. The enclosing
main-executor scope handles typed persistence failures through the same
presenter. This deliberately proves that AppKit identity can participate in a
cross-thread operation without becoming generally shareable or atomically
reference counted.
