# Ownership pressure log

This log tests Z's ownership model against application-shaped code. It records
observed friction before changing the language, and separates ownership-model
questions from bootstrap implementation gaps.

## Desktop probe 1: owned model plus AppKit shell

Source: [`examples/interop/objc/desktop-ownership`](../examples/interop/objc/desktop-ownership)

What works:

- an ARC-managed `Workspace` can be shared while its methods mutate through an
  explicit `inout this` capability;
- `Array<Document>` owns move-only struct elements containing owned `String`
  values, and `push` transfers each document into stable application state;
- borrowed methods inspect scalar state without copying or exposing storage;
- imported AppKit classes are nominal Z types, so an ARC-managed
  `WindowController` stores both `AppKit.NSWindow` and the Z-owned `Workspace`;
- native run output streams immediately, so diagnostics emitted before entering
  AppKit's event loop are visible while the window is still open.

## Pressure 1: borrowed views cannot escape

A borrowed method can return a copied scalar such as `i32`, but it cannot return
an owned `String` field from a borrowed document without transferring that field
out of borrowed storage. `Slice<T>` similarly cannot be returned, stored, or
captured today. This is the deliberate non-escaping wall that replaces explicit
source lifetimes in the current model.

Keep these candidate spikes available when a real caller needs a view:

1. a scoped callback such as `withDocument(index, (in document) => ...)`, which
   keeps the borrow lexical;
2. an explicit owned snapshot/copy API when copying is the desired contract;
3. the implemented inferred `view` return whose lifetime is tied to a
   value-struct receiver, without exposing general lifetime annotations;
4. a region or generational-borrow experiment if scoped callbacks become common
   enough to harm readability.

Do not choose among them from syntax alone. Add the smallest spike when a real
program needs to retain or return a view, then compare call sites, diagnostics,
code generation, and optimizer results.

The deterministic [`ownership-views.z`](../examples/interop/objc/desktop-ownership/ownership-views.z) probe now
exercises candidates 1 through 3 against the same lookup:

| Shape | Source contract | Generated cost | Usability boundary |
| --- | --- | --- | --- |
| `withDocument(id, callback)` | callback receives `in Document` | `const Document *`, stack closure environment, indirect call; no title copy | zero-copy, but all use is nested inside the callback |
| `documentSnapshot(id)` | returns owned `Option<Document>` | option tag plus a new `String` allocation and exact byte copy | straight-line and remains valid across workspace mutation |
| `documentAt(index): view Document` | inferred receiver-tied borrow | `const Document *`, bounds check, no document or string copy | straight-line until the view's last use; owner mutation is then permitted |
| `document(id): Option<view Document>` | optional receiver-tied borrow, inspected with `match (in result)` | one `const Document *`; `NULL` is `none`, no tag or string copy | natural fallible lookup; `some` inherits owner provenance and `none` carries no borrow |

The scoped form reads naturally for enumeration and one operation. It becomes
awkward when several later statements need the selected document. The snapshot
is semantically honest when the result must survive `Workspace.open`, but its
copy would be accidental overhead for immediate read-only use.

This evidence produced a narrow receiver-tied read-only view rather than general
lifetime parameters. Its provenance is one borrowed value-struct receiver; it
is non-storable, non-forwardable, and non-capturable, and receiver mutation is
rejected until the view's last use. `Option<view T>` carries the same provenance
through a constrained local enum shape without admitting general borrowed enum
storage. ARC class owners remain excluded because an alias could mutate the same
storage. Callers needing aliasing or survival across reallocation must use an
owned snapshot or a future stable reference model.

## Pressure 2: imported Objective-C references in owned Z state

Resolved for non-null class references: `AppKit.NSWindow` is a nominal source
type and can be used in Z fields and signatures. The desktop probe stores a
window on an ARC-managed Z `WindowController`. Generated Objective-C uses a
strong field, zero-initializes class storage before the first ARC assignment,
and clears the field before freeing the surrounding Z allocation.

Nullable imported references remain a distinct one-pointer type and editor
services display them as `T | null`. Z now rejects unchecked member access and
narrows after explicit `value != null` / `value == null` control flow. An
explicit source annotation is supported for imported Objective-C reference
fields, parameters, returns, and locals. Protocol-qualified `id`, weak/unowned
foreign fields, and ownership attributes imported from API notes remain later
slices.

## Pressure 3: interactive AppKit adapter surfaces

Resolved for both one-shot and persistent Objective-C block shapes. The desktop
probe passes an owned `move` closure to `beginWithCompletionHandler`. AppKit
copies the block; a generated ARC box retains the Z closure environment and
releases it exactly once when the native block dies. The completion event
mutates the owned `Workspace`, proving a real AppKit-to-Z state path rather
than a static window.

The persistent notification probe registers blocks with
`NSNotificationCenter`, retains each returned observer token, weakly captures
ARC-managed Z state, receives repeated events, and explicitly unregisters both
tokens after the AppKit event loop returns. A deterministic Foundation fixture
posts twice, removes its token, and proves a third post cannot invoke the Z
closure. This validates the native token/block lifetime without creating a
strong reference cycle.

Borrowed captures are rejected at an escaping block boundary. Non-escaping
blocks can borrow lexically. Named function values, block returns with richer
foreign object ownership, target/action selector adapters, delegates,
cross-thread delivery, and Z-defined Objective-C protocol conformance remain
separate follow-ups.

## Pressure 4: owned strings across Objective-C

Resolved for non-null `NSString` boundaries. Computed Z strings can populate
Objective-C properties and arguments. Z passes `data + length` into an ARC
`NSString`, so embedded NUL bytes are preserved. In the reverse direction, an
explicit `String` destination copies a non-null `NSString` into fresh owned Z
storage using its exact UTF-8 byte length.

The copy is intentional: a Z `String` never borrows storage returned by
`UTF8String`, whose lifetime belongs to the Objective-C object. Nullable
`NSString` cannot convert until it is narrowed. Other encodings, zero-copy
views, mutable strings, and explicit conversion APIs remain later pressure
tests.

## Pressure 5: foreign RAII values inside Z aggregates

Resolved for copyable C++, move-only C++, and generated Swift C++ wrapper values
in the first synchronous storage tier. An adjacent
`.zd` type contract may constrain Clang-proven `copy`, `move`, and `deinit`
capabilities without repeating layout. The C++ probe copies a contracted value
into an owning Z struct, copies that struct, and observes three native drops with
zero live values. The Swift probe stores and copies `OwnedCounter` inside a Z
struct while its shared Swift class payload is released exactly once.

This relies on the C++ backend's native member construction, assignment, move
construction, and lexical destruction rather than byte copying or synthesized
destructor calls. The move-only probe borrows a native value, transfers it
through an owned function and a whole Z value struct, rejects later source use,
and observes zero live native values after scope exit.

## Application probe 2: document workspace

Source: [`examples/applications/document-workspace`](../examples/applications/document-workspace)

This cross-platform command-line probe uses application vocabulary rather than
ownership-test verbs. A `DocumentWorkspace` registers documents, rejects an
invalid draft, finds a session, grows after the lookup borrow ends, saves every
open document, and reports a summary. Each `DocumentSession` owns a `String`
title and a move-only C++ `DocumentLease`; the workspace owns a growable array
of sessions.

What the complete run proves:

- an exported named enum can move a native-owning `DocumentSession` across a Z
  module boundary and into `Array<DocumentSession>`;
- array growth native-move-constructs the mixed Z/C++ aggregate and final
  cleanup leaves zero live leases;
- `Option<view DocumentSession>` supports borrowing method calls, ends at last
  use, and permits later collection growth;
- a typed `WorkspaceError` owns an interpolated `String`, moves through
  `throw`, `try`, `attempt`, and `match`, and is cleaned on the handled path;
- `inout` at the ordinary function boundary makes workspace mutation visible
  without a callback-specific capability model.

The probe found three implementation bugs that are now closed: module-mangled
named enums were misclassified as compiler-generated result storage, calls
through optional views generated a pointer-to-pointer, and `throw` bypassed the
ordinary statement-valued lowering needed by directly constructed errors with
interpolated messages.

## Not tested yet

- spawned mutable, output, Slice, and cross-thread borrows that survive suspension;
- parameter-provenanced, retained, or class-owned views;
- cross-thread ownership, atomic ARC, and sendability;
- cyclic application graphs under ORC;
- storing move-only native values in ARC fields or owned closure environments;
  compiler `Option`/`Result` payloads, direct native async locals and owned
  parameters, immutable scoped async borrows, direct-awaited mutable borrows,
  whole Z value aggregates containing them, and fallible results now survive
  suspension, return/await relay, `try`/`attempt`, match, failure, and
  cancellation;
- Windows C++ UI ownership and callback shapes.

Each belongs in a vertical application probe before its design is treated as
settled.
