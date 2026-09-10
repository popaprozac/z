# Native Objective-C subclass design

Status: declaration and construction direction approved, 2026-09-09. The first
field-free, synchronous **Stage 0** tier is implemented and tested. The
self-hosted frontend preserves the declaration syntax, checks imported
declaration contracts and structural receiver rules, and uses the ordinary
expression/call/loan checker for a first native body-typing tier. Target-aware
Objective-C availability checks are present. Native execution remains explicitly
gated on complete ownership/availability composition and emission.
Stateful subclasses and production window
integration remain separate checkpoints.

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
strict Clang and UBSan. Two hundred iterations cover constructions, base-reference virtual calls,
selector aliases, superclass dispatch, post-initialization native properties,
and scope cleanup, including an owned callback that keeps its native receiver
alive after the creator returns and releases it on callback destruction. They
leave zero live fixture objects. A real `NSWindow` subclass
passes compile-only verification without launching a GUI. Rejection tests cover
construction, ABI, lifecycle, effects, and representation boundaries. Editor
tests cover contextual keyword tokens, native identity/override hover, and
superclass/inherited member completion. No ASan is required.

Native preparation now includes exact parser-shape parity for the superclass,
override marker, selector, constructor, and native call syntax. `ZFDCL` version
15 carries interface availability alongside Clang's subclassing restriction, designated initializer, required
super call, direct dispatch, consuming receiver/parameter ownership, and
variadic facts into Z-owned declarations. Native normalization and module
signatures retain those facts, including the unprojected result's nullability.
Methods with an unsupported ABI remain separate, non-callable evidence so they
cannot disappear from override checking or become accidentally callable.
A native Z fixture checks the entire decoder/normalizer/signature path, both
present and absent facts, exact consuming-parameter positions, malformed input,
and obsolete-version rejection. Declaration checks cover restricted and
main-isolated bases, inherited selectors, exact override types/capabilities,
forbidden effects/ownership, and designated/nonnullable initializer selection.
The native syntax-tree body pass enforces exactly-once superclass initialization,
rejects receiver use in initializer arguments (including nested expressions and
closures), and keeps `super` a direct, non-capturable call receiver. Constructor
returns are rejected through branches, match arms, and expression blocks, while
a nested closure's own `return` remains legal. Native implicit receiver names
cannot be shadowed by parameters, locals, or destructured/pattern bindings.
Every discovered superclass call is matched against inherited selector, arity,
label, ABI-representability, and consuming/variadic contracts.

The first native typed-body pass prepares a nominal source subclass with an
imported base-pointer ABI, not an ordinary Z ARC record or an alias of the base.
`this` and `super` share one alias identity; inherited properties and methods use
ordinary member lookup, argument/result checking, and loan analysis. Local
override calls retain their declared Z parameter capabilities. Evidence separates
superclass initialization, superclass dispatch, and ordinary virtual calls.
Tests cover scalar arguments/results, missing returns/names, property reads and
setters, readonly-property rejection, subclass-to-base conversion, rejected
downcasts/sibling conversions, reinitialization through aliases, and overlapping
receiver loans. The literal `thread.main` affinity must resolve to the imported
`std/thread` capability. Consuming and variadic native calls remain rejected in
this body tier.

The ownership follow-up distinguishes cleanup from unique ownership: native
Objective-C references (including source subclasses, nullable references, and
transparent aliases) cannot be explicitly moved merely because ARC must release
them. Ordinary assignment/argument passing still retains shared identity. Direct
`this` capture remains rejected consistently with Stage 0; capturing a named alias
in an explicitly typed `move` closure retains that alias instead. Tests preserve
owned String moves/captures, borrowed object-parameter retention, and inline
synchronous `in` callbacks while rejecting use after a String move.

Native inferred closures now retain compiler-internal environment provenance.
The checker rejects borrowed captures entering typed function values, generic
owned arguments, aggregate fields, arrays, enum payloads, returns, and owned
nested captures with `Z0212`, before the execution gate. Signature rebasing and
type identity preserve the provenance; it does not add public syntax or a runtime
field. Direct inferred lexical invocation, noncapturing function values, typed
owned captures, and inline synchronous `in` callbacks retain positive parity
coverage. Named inferred closures still cannot convert to managed callback
parameters, matching Stage 0's current boundary.

The follow-up source-body proof closes the ordinary-Z forwarding hole found
after direct conversion parity. Both checkers reject passing an inline borrowed
capturing closure to a helper that returns, stores, aliases, or captures that
callback. Direct synchronous invocation and proven named forwarding remain
accepted, including cross-module aliases and generic helpers. Unknown, dynamic,
recursive, raw, and deferred forwarding remain conservative. The proof stays on
the known implementation rather than the structural function type. Owned `move`
callbacks and native blocks with ARC-backed environments remain retainable.
Native inline callback arguments also receive call-scoped storage with cleanup
on normal and typed-error paths. See the evidence in
[ownership pressure](ownership-pressure.md#borrowed-callback-forwarding-follow-up).

The standalone driver now passes the existing project `target.platform` and
`target.minimumVersion` into parsed module context. Without a configured target,
compiler-private host evidence supplies the platform, not an invented minimum
version. Native superclass hierarchies, overrides, initializers, superclass and
virtual calls, and property reads/writes enforce applicable unavailable,
introduced, and obsoleted facts with `Z0802`. Restrictions for other platforms
do not apply. Numeric dotted versions compare component-wise (including trailing
zeroes), not as decimals. Version-dependent checks require a configured minimum,
matching Stage 0; platform-only bans still apply without one. Detached semantic
probes lacking platform evidence fail closed when they need it.

Deprecation metadata survives the decoder/normalizer/signature path but native
warning reporting remains separate work. These checks are scoped to native
subclass declarations and bodies, not a claim of complete availability checking
for every native C-family call in the self-hosted compiler.

These checks do not yet authorize native subclass execution: semantic resolution
still reports `Z0814` before an executable graph can leave the resolver. A
source-only probe without attached superclass ABI evidence cannot enter typed
body checking. Complete ownership and availability composition are still required;
passing this limited typed oracle is not a claim that every body composition is
safe to emit.

Next: remaining callable/body ownership and lowering parity—starting with the
recorded mutable lexical block-capture emission gap—and availability/diagnostic
composition, then native subclass
lowering/emission parity; afterward
deliberate and test owned state, initialization/teardown callbacks, and reentrancy
before Zapp's window transition state moves into a subclass.

The remaining field-free native port is bounded by four gates:

1. **Complete:** carry raw safety facts through native foreign normalization and
   module signatures, without exposing unsupported native ABIs as callable.
2. **In progress:** declaration contracts, structural receiver/initialization
   rules, superclass call/capture checks, nominal receiver identity, first
   argument/result/property typing, imported executor capability validation,
   alias-exclusivity tests, and target-aware Objective-C availability errors are
   present. Complete body ownership and remaining availability/diagnostic parity
   before accepting a native subclass as checked executable Z.
   The first typed-body slice reuses the loan checker but does not yet establish
   safety for every capture, move, return, or reentrant native call.
   Executable plans must require attached ABI evidence; the source-only
   declaration deferral must never become a successful execution path.
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
