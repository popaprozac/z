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
- inferred AppKit object references use Objective-C ARC and coexist with Z-owned
  model state in the same native program.

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

## Pressure 2: imported Objective-C references are inferred-only

`AppKit.NSWindow` is understood when inferred from an imported call, but the
bootstrap does not yet accept that spelling in a Z field, parameter, or return
annotation. Consequently the native window cannot yet be stored directly on
`Workspace`. This is an interop type-surface gap, not evidence against the
ownership model. The follow-up must expose imported reference types as nominal
source types and define ARC behavior when they are fields of Z structs/classes.

## Pressure 3: interactive AppKit needs adapter surfaces

A static native window works, but a real button/menu/delegate path needs
Objective-C blocks, target/action selector adapters, or Z-defined Objective-C
protocol conformance. Those are missing interop features. They should be tested
with one real event flowing from AppKit into owned Z state before a broad binding
design is committed.

## Pressure 4: strings stop at literals

String literals bridge contextually to `NSString`, but a computed Z `String`
cannot yet populate an AppKit property. A real desktop view model will require a
defined owned/borrowed bridge in both directions. This should share the future
Foreign Interface IR rather than becoming an AppKit-specific conversion.

## Not tested yet

- a borrow that must survive suspension;
- cross-thread ownership, atomic ARC, and sendability;
- cyclic application graphs under ORC;
- storing Swift-native or general C++ RAII values inside Z aggregates;
- Windows C++ UI ownership and callback shapes.

Each belongs in a vertical application probe before its design is treated as
settled.
