# Native Objective-C subclass design

Status: declaration and construction direction approved, 2026-09-09. The first
field-free, synchronous **Stage 0** tier is implemented and tested. The
self-hosted frontend preserves the declaration syntax and imports the native
safety facts, but rejects subclass semantic checking/emission explicitly until
that parity lands. Stateful
subclasses and production window integration remain separate checkpoints.

## Motivation

Zapp's isolated window-resize probe demonstrated visibly more responsive WebKit
viewport updates with display-driven, nonanimated intermediate window frames.
Further background/transaction variants did not establish a meaningful visual
improvement. The simpler stepped algorithm is the baseline.

Naive delegate-only zoom interception failed the interrupted-zoom restore test.
This does not prove every composition-based design impossible, but it motivates
preserving AppKit's native zoom state through subclass hooks rather than
independently reimplementing those rules in Zapp.

The language capability must be general native interop, not an NSWindow-specific
intrinsic. Existing `implements` / `objc.adapt<P>` emits an `NSObject<Protocol>`
adapter retaining a separate Z controller. It does not supply native subclass
identity, overrides, or superclass dispatch.

## Approved declaration direction

```zs
import AppKit from "AppKit/AppKit.h";
import { thread } from "std/thread";

class SmoothWindow extends AppKit.NSWindow on thread.main {
  constructor(frame: AppKit.NSRect) {
    super.initWithContentRect(
      frame,
      styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskResizable,
      backing: AppKit.NSBackingStoreBuffered,
      defer: false
    );
    this.releasedWhenClosed = false;
  }

  override function animationResizeTime(
    frame: AppKit.NSRect
  ): f64 as "animationResizeTime:" {
    return super.animationResizeTime(frame);
  }
}
```

This class passes strict Clang compilation through Stage 0. It is not a complete
resize implementation: its override forwards unchanged behavior. Construction
uses `new SmoothWindow(frame)`, not an object-literal initializer.

- `extends` initially names one imported Objective-C superclass. It denotes a
  real native subclass, not an adapter or structural resemblance.
- `override` requires an inherited native method with a compatible signature.
- `as "selector:"` reuses the existing explicit native-selector mapping.
- `super` invokes the superclass implementation on the same native object;
  ordinary virtual dispatch back into the override would be incorrect.
- `on thread.main` uses the existing executor vocabulary. Declaring affinity
  does not prove that arbitrary native callers honor it; callback provenance
  and inherited requirements remain part of checking.
- Ordinary Z-to-Z inheritance is not enabled. Existing Z ARC classes and
  protocol adapters keep their current semantics.

The generated class has one native ARC identity. It does not allocate a Z ARC
record or a protocol-adapter wrapper. Ordinary calls use Objective-C dispatch;
`super` uses native superclass dispatch. A base-class reference still invokes
the override. Local method names may differ from their explicit native selector.

## Approved construction and current restrictions

An explicit `constructor` begins with exactly one direct superclass designated
initializer. Its arguments cannot refer to `this` or `super`. After that call,
ordinary native property assignments and synchronous calls are available.
Constructor arguments currently accept scalars, enums, and plain native records
(including `NSRect`), by value. Constructors must fall through rather than return
early in this first tier.

The generated initializer assigns the native result back to `self`; it does not
discard the returned object. Nil or replacement objects with a different dynamic
class fail closed at runtime. Nullable initializer contracts are rejected before
emission pending an explicitly fallible construction tier. Inherited initializer
entry points cannot bypass `new`, and reinitialization is rejected on a known Z
native subclass receiver. Every generated native entry checks the main thread.
This is a contract guard, not an implicit executor hop.

The first tier deliberately rejects:

- ordinary Z inheritance, generic subclasses, missing main affinity, and
  imported classes that forbid subclassing;
- Z-stored fields, `deinit`, `Weak`, and protocol/trait composition;
- asynchronous, throwing, consuming, static, generic, block-receiving, or
  object-returning overrides, plus variadic native signatures;
- native lifecycle/runtime overrides, direct (`objc_direct`) methods, consuming
  native ownership contracts, and explicit manual ARC lifecycle calls;
- methods marked `NS_REQUIRES_SUPER` until path validation exists;
- capturing `super`, treating it as a value, or using it outside the native class;
- composition with async lowering or the self-hosted frontend.

Selector and ABI compatibility, subclass restrictions, designated initializer
metadata, native availability, and executor requirements come from imported
declarations. Behavioral assumptions about a native initializer or callback are
still trusted native contracts, not proved by reading a header.

## Remaining state and safety decisions

The first fixture should separate field-free override/super dispatch from the
later stateful window implementation. A passing stateless fixture does not
establish stateful subclass safety. Before fields or cleanup hooks ship, settle:

1. Broader inherited construction entry points and constructor argument ownership.
2. Nullable/replacement initializer results and cleanup on failed construction.
3. Native virtual callbacks during initialization or teardown: ordinary Z
   definite-assignment analysis alone cannot prove these callbacks safe.
4. Owned-field lifetime, native ARC destruction, and weak references.
5. Native reentrancy while an exclusive Z borrow is active, even on main.
6. Header restrictions on subclassing/overriding and required superclass calls.
7. Exception, suspension, ownership, and executor compatibility at each native
   entry. Do not silently let Z errors unwind through a nonthrowing native ABI.

Keep these restrictions explicit in diagnostics, editor support, tests, and
bootstrap status. Unknown native behavioral facts are not proofs. Do not ship
unchecked stateful inheritance behind an ergonomic declaration.

## Implementation evidence to require

- A small native base-class fixture invoked from both Z and Objective-C.
- Exact selector/ABI checking, ordinary dispatch versus `super`, and safe native
  base-reference conversion without a new wrapper.
- Negative tests for invalid bases, selectors, signatures, effects, affinity,
  and unsupported construction/lifetime shapes.
- Native frontend parity as well as Stage 0 execution; semantic highlighting,
  hover, and inherited-method completion alongside the compiler feature.
- Stateful lifetime/reentrancy tests before integrating Zapp's window logic.
- Window zoom/restore, rapid reversal, arbitrary target replacement, immediate
  changes, close/shutdown, Reduce Motion, and idle-driver cleanup evidence.

The research Objective-C probe remains an isolated test oracle, not a new
handwritten production backend.

Current evidence: `tests/objc-subclasses.test.ts` runs a native base fixture under
strict Clang and UBSan. Two hundred constructions, base-reference virtual calls,
selector aliases, superclass dispatch, post-initialization native properties,
and scope cleanup leave zero live fixture objects. A real `NSWindow` subclass
passes compile-only verification without launching a GUI. Rejection tests cover
construction, ABI, lifecycle, effects, and representation boundaries. Editor
tests cover contextual keyword tokens, native identity/override hover, and
superclass/inherited member completion. No ASan is required.

Native preparation now includes exact parser-shape parity for the superclass,
override marker, selector, constructor, and native call syntax. `ZFDCL` version
14 carries Clang's subclassing restriction, designated initializer, required
super call, direct dispatch, consuming receiver/parameter ownership, and
variadic facts into Z-owned declarations. A native Z decoder fixture checks
both present and absent facts, exact consuming-parameter positions, malformed
input, and obsolete-version rejection. These facts do not yet authorize native
subclass execution: semantic resolution reports `Z0814` before an ordinary Z
class representation could be substituted.

Next: native semantic checking and lowering/emission parity; then deliberate and
test owned state, initialization/teardown callbacks, and reentrancy before Zapp's
window transition state moves into a subclass.

The remaining field-free native port is bounded by four gates:

1. Carry the raw safety facts through native foreign normalization and module
   signatures, retaining native superclass identity rather than ordinary Z ARC
   layout.
2. Enforce the same constructor, override, ownership, and executor restrictions
   in native semantic analysis, with matching negative tests.
3. Lower checked constructor/super calls and native method entries into explicit
   IR, then emit native interfaces/implementations and ARC construction without
   a Z wrapper. Keep generated symbols inaccessible through raw source.
4. Run the same virtual-dispatch, superclass, alias, construction, and exact
   destruction fixture through a freshly built native compiler; only then remove
   the native `Z0814` implementation boundary.

## References

- [Current Objective-C interop](interop-model.md)
- [Apple: NSWindow animationResizeTime](https://developer.apple.com/documentation/appkit/nswindow/animationResizeTime(_:))
- [Apple: object initialization](https://developer.apple.com/library/archive/documentation/General/Conceptual/CocoaEncyclopedia/Initialization/Initialization.html)

The Apple initialization reference includes manual-retain/release examples;
Z's native implementation must use modern Objective-C ARC rules, not copy those
manual ownership calls.
