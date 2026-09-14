# Z-owned state and helpers in native subclasses

Status: proposal for deliberation, 2026-09-14. Not implemented or approved.

## Pressure case

Zapp's native window drag path needs an ordinary Z gesture observer that owns
the native window, WebView, and document-generation checks. The window should
hold only `Option<Weak<GestureObserver>>`; asynchronous WebKit completions should
also capture weak observer handles. The runtime owns the observer. This avoids
both a window/observer ownership cycle and delayed completions retaining a
closed window's runtime graph.

Two existing compiler boundaries prevent this composition:

1. `compiler/src/sema.ts` restricts native stored fields to owned String,
   scalars, plain native records, and strong imported Objective-C references.
   `Option<Weak<GestureObserver>>` is rejected with Z0814.
2. `compiler/src/objc-subclasses.ts` requires every declared method to have
   `as "selector:"`, including private implementation helpers. There is no
   ordinary Z-only method layer inside a native subclass today.

The language surface being proposed uses existing syntax, schematically:

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
