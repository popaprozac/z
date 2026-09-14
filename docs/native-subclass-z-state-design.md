# Z-owned state and helpers in native subclasses

Status: approved direction, 2026-09-14. Weak-field storage is implemented;
private Z-only helper methods remain the next checkpoint.

## Pressure case

Zapp's native window drag path needs an ordinary Z gesture observer that owns
the native window, WebView, and document-generation checks. The window should
hold only `Option<Weak<GestureObserver>>`; asynchronous WebKit completions should
also capture weak observer handles. The runtime owns the observer. This avoids
both a window/observer ownership cycle and delayed completions retaining a
closed window's runtime graph.

Two compiler boundaries motivated this composition work:

1. `compiler/src/sema.ts` previously restricted native stored fields to owned String,
   scalars, plain native records, and strong imported Objective-C references.
   `Option<Weak<GestureObserver>>` was rejected with Z0814. The first checkpoint
   now admits `Weak<T>` and `Option<Weak<T>>` for ordinary Z classes.
2. `compiler/src/objc-subclasses.ts` requires every declared method to have
   `as "selector:"`, including private implementation helpers. There is no
   ordinary Z-only method layer inside a native subclass today.

The approved complete surface uses existing syntax, schematically (the helper
below is not executable until the next checkpoint):

```zs
class NativeWindow extends AppKit.NSWindow on thread.main {
  private observer: Option<Weak<GestureObserver>>;

  // Ordinary Z-only implementation detail: no Objective-C selector.
  private function currentObserver(): Option<GestureObserver> { /* ... */ }

  // Explicit Objective-C entry, with the existing checked ABI contract.
  override function sendEvent(in event: AppKit.NSEvent): void as "sendEvent:" {
    // ... delegate to ordinary Z state, forward the original event ...
  }
}
```

## Recommended bounded direction

- Distinguish Z-only helpers from native entries using the existing explicit
  `as` spelling. An override remains a checked native selector; no implicit
  selector inference or new decorator/keyword is proposed.
- Start with synchronous private helpers and the managed value storage needed
  by this case. Review the exact admitted type set before implementation;
  do not special-case a framework's class names or grant arbitrary raw fields.
- Extend normal ownership, cleanup, executor and receiver-access proofs to the
  stored Z values. Do not remove the existing fail-closed validation wholesale.
- Preserve straight-line initialization after successful `super.init`, cleanup
  exactly once, native reentry guards, and in-flight receiver pinning. Helpers
  must not accidentally reacquire an already-held receiver access or bypass it.
- Keep native ABI validation and `objc.selector` limited to explicit native
  entries. Z-only helpers must not become selector-addressable by accident.
- Preserve native frontend/Stage 0 parity, LSP diagnostics and hover, and update
  the interop documentation/website only as executable support lands.

Acceptance needs: construction failure and destruction; empty/live/expired
weak handles; no retain cycle; safe callback after observer/window teardown;
receiver reentry and helper nesting; invalid executor or escaping borrow use;
native selector rejection for helpers; and Stage 0/native O0/O2 UBSan probes.

This is a general interop capability, not a Zapp API. The native gesture
prototype is parked in Zapp's `docs/plans/prototypes/native-window-drag.patch`.
It is uncompiled draft work, not a verified native gesture implementation.

## Weak-field storage checkpoint

`tests/fixtures/objc-subclass-weak-state.zs` exercises empty and expired optional
handles, live upgrade, replacement, retained direct weak snapshots, and a Z
observer that strongly owns its native window without a retain cycle. A late
weak callback, an imported observer class, and both source-deinit and
automatic-only cleanup variants run at `-O0`/`-O2` with UBSan and test-only
allocation accounting. Both
compilers use their ordinary weak/enum cleanup and retain the existing native
entry guards. Native lowering resolves the field's checked Z type rather than
inventing an Objective-C ABI for it. Resolved native subclasses remain invalid
weak targets, including forward declarations.

`Option<Weak<T>>` is borrowed with `match (in this.observer)`. This does not add
general `copy Option<T>` support or permit moving an owned field out of its
receiver. Arbitrary managed aggregates, native weak references, escaping field
loans, and cross-thread weak upgrade remain outside this checkpoint.

The executable callback probe uses a block body. During testing, the equivalent
expression-bodied `move (): i32 => match (...) { ... }` exposed a separate native
lowering gap; preserve that as a follow-up rather than claiming every closure
expression shape is covered here. It needs no new syntax or public API.

## Private-helper implementation seam

A bounded Clang syntax probe confirms that a private C function defined inside
`@implementation` may access that class's private ivars. This provides a route
to genuinely Z-only helpers without synthesizing Objective-C selectors. The
next slice still needs checked receiver-access propagation: a direct nested
helper must not reacquire an already-held exclusive entry loan, while a call
through a different receiver cannot bypass that receiver's guard. Constructor
readiness and superclass handoff rules must remain explicit in that lowering.
