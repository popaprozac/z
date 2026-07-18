# Ownership pressure log

This log tests Z's ownership model against application-shaped code. It records
observed friction before changing the language, and separates ownership-model
questions from bootstrap implementation gaps.

## Desktop probe 1: owned model plus AppKit shell

Source: [`examples/desktop-ownership`](../examples/desktop-ownership)

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
3. a future inferred `view` return whose lifetime is tied to a receiver or
   parameter, without exposing general lifetime annotations;
4. a region or generational-borrow experiment if scoped callbacks become common
   enough to harm readability.

Do not choose among them from syntax alone. Add the smallest spike when a real
program needs to retain or return a view, then compare call sites, diagnostics,
code generation, and optimizer results.

The desktop probe now exercises candidate 1 through
`eachDocument(in visit: (in document: Document) => void)`. Its call site is an
ordinary contextual closure, and generated C passes each element as a
`const Document *` without copying its owned `String`. This reads naturally for
enumeration and keeps the lifetime entirely lexical. It does introduce
inversion of control and does not replace a future view-return solution for APIs
that genuinely need one retained result, so the broader question remains open.

## Pressure 2: imported Objective-C references in owned Z state

Resolved for non-null class references: `AppKit.NSWindow` is a nominal source
type and can be used in Z fields and signatures. The desktop probe stores a
window on an ARC-managed Z `WindowController`. Generated Objective-C uses a
strong field, zero-initializes class storage before the first ARC assignment,
and clears the field before freeing the surrounding Z allocation.

Nullable imported references remain a distinct internal type until Z has a
source-level nullable spelling and narrowing rules. Protocol-qualified `id`,
weak/unowned foreign fields, and ownership attributes imported from API notes
remain later slices.

## Pressure 3: interactive AppKit adapter surfaces

Resolved for the first Objective-C block shape: the desktop probe passes an
owned `move` closure to `beginWithCompletionHandler`. AppKit copies the block;
a generated ARC box retains the Z closure environment, and releases it exactly
once when the native block dies. The completion event mutates the owned
`Workspace`, proving a real AppKit-to-Z state path rather than a static window.

Borrowed captures are rejected at an escaping block boundary. Non-escaping
blocks can borrow lexically. Named function values, block returns with richer
foreign object ownership, target/action selector adapters, delegates, and
Z-defined Objective-C protocol conformance remain separate follow-ups.

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

## Not tested yet

- a borrow that must survive suspension;
- cross-thread ownership, atomic ARC, and sendability;
- cyclic application graphs under ORC;
- storing Swift-native or general C++ RAII values inside Z aggregates;
- Windows C++ UI ownership and callback shapes.

Each belongs in a vertical application probe before its design is treated as
settled.
