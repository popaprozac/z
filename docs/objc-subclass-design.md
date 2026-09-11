# Native Objective-C subclass design

Status: declaration and construction direction approved, 2026-09-09. The first
stateful, synchronous tier executes in **Stage 0 and the native compiler**. The
self-hosted frontend preserves the declaration syntax, checks imported
declaration contracts and structural receiver rules, and uses the ordinary
expression/call/loan checker for a restricted native body-typing tier. Target-aware
Objective-C availability checks and the synchronous body audit are present. Native
lowering preserves explicit native construction, method entries, and superclass
dispatch. Checked entry plans drive real Objective-C interfaces and implementations,
with no Z ARC record wrapper. The same 200-iteration virtual-dispatch and exact
cleanup fixture passes both emitters under strict Clang and UBSan.
The lifecycle-forwarding direction is approved and implemented in both emitters:
construction and destruction dispatch to the superclass, while ready instances
enter Z overrides. Private scalar/plain-native-value, owned `String`, and strong
imported Objective-C reference fields, plus source `deinit`, are implemented.
Broader resource fields and production window integration remain separate checkpoints.

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

This class passes strict Clang compilation through both compilers. It is not a complete
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
discard the returned object. Nil, replacement objects with a different dynamic
class, or already-ready receivers fail closed at runtime. Nullable initializer contracts are rejected before
emission pending an explicitly fallible construction tier. Inherited initializer
entry points cannot bypass `new`, and reinitialization is rejected on a known Z
native subclass receiver. Every generated native entry checks the main thread.
This is a contract guard, not an implicit executor hop.

The first tier deliberately rejects:

- ordinary Z inheritance, generic subclasses, missing main affinity, and
  imported classes that forbid subclassing;
- public stored fields, storage beyond scalars/plain native values/owned `String`
  and strong imported Objective-C references, escaping field loans, `Weak`, and
  protocol/trait composition;
- asynchronous, throwing, consuming, static, generic, block-receiving, or
  object-returning overrides, plus variadic native signatures;
- native lifecycle/runtime overrides, direct (`objc_direct`) methods, consuming
  native ownership contracts, and explicit manual ARC lifecycle calls;
- methods marked `NS_REQUIRES_SUPER` until path validation exists;
- capturing `super`, treating it as a value, or using it outside the native class;
- composition with async lowering.

Selector and ABI compatibility, subclass restrictions, designated initializer
metadata, native availability, and executor requirements come from imported
declarations. Behavioral assumptions about a native initializer or callback are
still trusted native contracts, not proved by reading a header.

## Approved selector reference and registration contract (2026-09-10)

The user chose the explicit `std/objc` utility over contextual conversion of
`window.onDisplay` into a selector:

```zs
import objc from "std/objc";

const link = window.displayLinkWithTarget(
  window,
  selector: objc.selector(SmoothWindow.onDisplay)
);
```

**Approved direction, not implemented yet.** The utility references the method
declaration, not a receiver instance. It neither invokes the method nor creates
a closure. The compiler must preserve receiver/signature evidence through the
checked registration boundary before emitting the ordinary native `SEL`.
No raw string-to-selector conversion is implied. Existing inherited overrides
continue to use `override function ... as "selector:"`; the proposed new native
callback uses `function ... as "selector:"` without `override`. A collision
with an inherited selector must require `override`, not silently replace it.

The registration contract is approved. Both compilers now parse and validate
the declaration below and retain the target/signature evidence. Executable
`objc.selector` references and new native method entries remain the next slice;
registration calls stay unavailable rather than accepting an unchecked `SEL`.

```zs
declare module "AppKit/AppKit.h" {
  export function NSWindow.displayLinkWithTarget(
    target: _,
    selector: _
  ): _ {
    callback selector {
      target target;
      type (in link: CADisplayLink) => void on thread.main;
      invoked repeatedly;
    }
  }
}
```

This extends `callback` to a native `SEL` parameter, adds `target` to pair
it with the native object parameter, and allows an inline function type after
`type`. No callback/context argument is removed or synthesized at the call.
The header proves the outer object/SEL/result ABI; the callback shape is a
trusted assertion from native documentation because `SEL` erases that shape.
The executable slice will check the referenced method's signature and the target's receiver type
against that assertion. This is not an independently Clang-verified callback
typedef, unlike the existing C callback contract.

The function type's `on thread.main` is an inbound requirement, not a claim
that the factory schedules delivery there. Generated method entries must
check main before touching Z state, with no implicit hop; the caller must add
the link to the main run loop. Do not invent an unconditional `thread caller`
promise for an API whose delivery depends on later run-loop registration.
The first signature tier accepts scalars/native enums and borrowed concrete
imported Objective-C object parameters, with scalar/native-enum or `void`
returns. Aggregate callback ABI and object return ownership remain later tiers.

No Z closure environment is created in this direct-native target tier.
Object retention remains native ARC behavior, not ownership of a generated
adapter. Explicit invalidation during live close/shutdown is still required;
this contract does not synthesize cycle collection or automatic registration
shutdown. Registration of the constructing/dying receiver must be rejected;
an unexpected new-selector invocation outside Ready must fail closed rather
than forward to a nonexistent superclass implementation.

The independent native contract decoder checks the same malformed contracts as
Stage 0 using raw Clang declarations, including target kind, argument names,
capabilities, missing facts, and executor requirements. `.zd` completion and
hover explain the trust boundary rather than describing a closure environment.
Next: checked selector references and native entries, paired registration and
lifetime tests, then the real resize integration. Native reentry during AppKit superclass operations
is a concrete integration test, not permission to weaken the approved guard.

## Approved state and lifecycle direction (2026-09-10)

The user approved ordinary stored fields and existing `deinit` syntax, with
native-entry lifecycle forwarding rather than an initialization-state API:

| Receiver phase | Virtual call behavior |
| --- | --- |
| Constructing | Invoke the superclass implementation, not the Z override. |
| Ready | Invoke the Z override. |
| Destroying | Invoke the superclass implementation again. |

This applies to native subclasses with or without fields. It is a deliberate Z
rule, not ordinary Objective-C dispatch. It includes explicit virtual calls made
by the Z constructor after `super.init`. Libraries requiring subclass callbacks
during initialization do not fit this first tier; do not silently claim compatibility.
`super` remains an unconditional superclass call when the object is ready too.

The field tier must prove every required field initialized before readiness.
Fields keep ordinary Z ownership and automatic cleanup. Existing `deinit` provides
extra synchronous cleanup; users never call `super.dealloc`. Destruction closes
the native-entry gate before cleanup, and cannot resurrect or publish `this`.
Main isolation is not a reentrancy proof: callbacks must not invalidate an
outstanding field view or exclusive loan. Reject unsupported combinations or
guard the boundary; do not silently weaken `inout` or add a reentrancy lock.
Display callbacks must stop during explicit close/shutdown while the owner is
live; final destruction cannot break a cycle that prevents it from starting.

### Implemented lifecycle gate

Both emitters add a private byte-sized readiness flag, subject to native layout
padding, in the native object. Allocation zero-initializes it. The initializer
opens the gate only after the constructor body **and local cleanup** finish.
Generated ARC `dealloc` closes it before the superclass deallocator; no explicit
`[super dealloc]` is emitted. The existing main-thread check precedes forwarding.
Fallback sends use checked native selector/parameter/result evidence, including
void and plain-record returns. The gate adds no wrapper or per-call heap allocation;
the flag and entry branch are intentional runtime costs, not zero overhead.

Constructor locals occupy an inner generated scope. Explicit Z cleanup alone
is insufficient: Clang also releases strong Objective-C locals at scope exit,
and their destructors can reenter the constructing receiver. Opening the gate
before that scope ended failed the regression oracle. The gate name is protected
by raw-source generated-symbol hygiene. Native subclass bindings also enforce Z's
existing reserved `_z_` prefix, and generated accesses qualify the receiver. A
superclass initializer returning an already-ready receiver is rejected instead
of letting another construction operate on its live state. This is internal ABI
hygiene and lifecycle enforcement, not a raw sandbox.

The differential fixture checks 200 iterations / 400 objects per run, with
callbacks from native initialization, the Z constructor after `super.init`, a
constructor-local ARC temporary's destructor, and native base teardown. Ready
dispatch includes nested calls and an escaping retained callback. Scalar,
multiargument, void, selector-alias, and plain-record forwarding run at `-O0`
and `-O2` under strict Clang and UBSan, with exact construction, temporary cleanup,
and destruction counts. No GUI or ASan is needed.

The lifecycle gate is also used by the stored-field tier below; readiness is
never enabled merely because the native superclass initializer returned.

### Implemented native-entry exclusivity

Ready override entries now enforce the existing receiver capabilities in both
compilers. An implicit or explicit `in this` permits nested readers; `inout this`
requires exclusive access. The checked native entry plan carries this capability
through lowering rather than inferring it from the selector at emission time.

| Active entry | Reentrant entry on the same receiver | Result |
| --- | --- | --- |
| `in this` | `in this` | Allowed |
| `in this` | `inout this` | Runtime contract failure |
| `inout this` | `in this` or `inout this` | Runtime contract failure |

This checks native callback/alias paths that lexical analysis cannot see. It is
not a mutex: there is no waiting, scheduling, or implicit hop. A conflict prints
`reentrant native subclass access conflicts with inout this` and traps before
entering the second Z body. An explicit `super` call still calls the superclass;
if that implementation calls back virtually, the callback checks the same rule.
Construction/destruction forwarding happens before this access check.

The access lasts through return-value evaluation and all body-local cleanup,
including native ARC local destructors. Generated lexical cleanup releases it
on early returns and normal fallthrough. A precise-lifetime strong receiver
reference outlives that cleanup: a callback may release the last outside native
owner, but it must not destroy the counter storage while the entry is using it.

Costs are explicit: one pointer-sized inline access counter in addition to the
readiness byte, a small stack guard, entry/exit checks, and a scoped native ARC
retain/release. There is no additional heap object or wrapper. This is a
conservative correctness tier, not a zero-overhead claim; reducing provably
unnecessary holds/checks is a later measured optimization.

The shared fixture now destroys 403 subclass objects per successful run. Six separate
conflict scenarios cover read→write, write→read, write→write, a read-local
destructor attempting a write, a write-local destructor attempting a read, and
a replaced native field's destructor reentering the exclusive receiver.
Positive cases cover read reentry, reader cleanup reentry, repeated exclusive
entries after return, void fallthrough, independent receivers, and final-owner
release from inside a method. Both emitters
run the cases at `-O0`/`-O2` under UBSan. Expected traps are intercepted by a
test-only native signal handler so they do not create host crash reports.

The independent-receiver case exposed a separate ownership bug: the generated
C constructor helper lacked `ns_returns_retained`. Its name does not carry the
Objective-C `init` method family's +1 convention. At `-O0`, constructing inside
an override left the result alive until the outer autorelease pool drained.
Both emitters now annotate the helper's declaration and definition with the
owned-return fact, so Z `new` does not depend on an optimized autorelease
return-value handshake for timely cleanup.

This closes the **entry** boundary, not escaping field borrowing. The implemented
storage tier keeps its fields behind those guarded entries.

### Implemented inline owned storage

```zs
class Counter extends native.CounterBase on thread.main {
  private offset: i32;
  private title: String;

  constructor(value: i32) {
    super.initWithValue(value);
    this.offset = 2;
    this.title = makeOwnedTitle();
  }

  override function value(): i32 as "value" {
    return super.value() + this.offset;
  }

  deinit {
    console.log(this.title);
  }
}
```

`CounterBase`, its imported initializer/selector, and `makeOwnedTitle` are
illustrative; the executable fixture is `tests/fixtures/objc-subclass.zs`.
There is one native allocation, with private inline ivars. Supported fields are
scalars, imported enums/plain native records, owned `String`, and concrete
imported Objective-C references (including `NativeClass | null`). Other storage
shapes fail closed; this does not yet promise arbitrary ARC/resource graphs.

Every field must be assigned once in a straight-line prefix immediately after
`super.init`, before other receiver use or control flow. Initializer expressions
may call helpers but cannot inspect the partially initialized receiver. The
first tier does not accept field defaults or optional-field shorthand. The
ordinary checker still checks types, transfers, readonly fields, and subsequent
uses. Access is direct `this.field` inside the native receiver body; source
privacy and generated ivar names keep external aliases out of this storage path.
Writing requires `inout this`; read entries remain shared. Receiver captures and
moved-out borrowed fields remain rejected. Copy a value snapshot when an owned
value needs to survive the entry.

Destruction closes the readiness gate, runs source `deinit`, finishes its Z and
native ARC local cleanup, then destroys fields in reverse declaration order.
Automatic field cleanup also runs without a source `deinit`. Source teardown
may inspect/copy fields but cannot call through or publish the dying receiver;
`super.dealloc` is never written or generated. Explicit close/shutdown is still
necessary for registrations or cycles that can prevent final ARC destruction.

Native object fields are strong ARC slots, not Z wrappers. Assignment retains
the new identity and releases the old one; assigning `null` clears a nullable
slot. A separate local snapshot retains its own identity, so clearing the field
does not invalidate that snapshot. Explicit `move` of native ARC identity remains
unsupported, as for ordinary native references. Clearing/replacing a field still
requires `inout this`, and native destruction that reenters a ready writer traps.
Generated teardown clears strong fields under the closed lifecycle gate before
superclass teardown. ARC's own ivar destruction then sees nil, avoiding duplicate
release. Source `deinit` may invoke a stored resource's cleanup method, but this
does not infer an API-specific `invalidate` or `close` operation for users.

For example, a display link can be represented by ordinary private nullable
storage, initialized to `null` immediately after `super.init`. Explicit shutdown
must invalidate its registration while the owner is still live. Retention is not
cycle collection: storing a link which retains its target can keep both alive.
Declaring a new callback selector such as `display:` (rather than overriding an
inherited selector) is the next design review, not part of this field checkpoint.

The shared 403-object fixture now owns an allocated string, replaces it through
an exclusive entry, reads native-record fields, and counts source destruction.
It also creates/destroys exactly 803 native resources, exercises nullable
replacement/clearing with a retained snapshot, and dispatches from a field's
destructor before superclass teardown. No callback is allowed to enter Z after
the destruction gate closes.
The native emitter uses checked field type/visibility plans. Tests reject partial
initialization, shared writes (including nested fields), receiver aliases,
escaping captures, readonly replacement, unsupported storage, and resurrection.

## Remaining state and safety work

The stateful compiler fixture is not yet the production window implementation.
Keep these wider cases explicit as storage expands:

1. Broader inherited construction entry points and constructor argument ownership.
2. Nullable/replacement initializer results and cleanup on failed construction.
3. Native virtual callbacks during initialization or teardown: ordinary Z
   definite-assignment analysis alone cannot prove these callbacks safe.
4. Broader owned resource/ARC fields, native destruction ordering, and weak references.
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

These checks originally preceded a blanket execution gate, now replaced by
dedicated native lowering and emission (see below). A source-only probe without
attached superclass ABI evidence still cannot enter typed
body checking. Passing this restricted typed oracle is not a claim that every
body composition is executable: lowering must continue rejecting unsupported
expressions rather than substituting an ordinary Z-class representation.

The mutable lexical block-capture gap is now closed for synchronous
callbacks with scalar and cleanup-free value captures. Synchronous borrowed
expression captures also address the original binding, including nested
forwarding and parent input/inout parameters, with zero-allocation probes.
Borrowed environments use stack storage; owned `move` expression and block
environments preserve mutable state across invocations. Both emitters retain cleanup and nonescape
regression coverage.

Synchronous non-void block callbacks now carry an explicit return/error context
through ordinary returns, selecting match arms, nested `try`, and cleanup
temporaries. The callback does not inherit its containing function's result or
error type. Invocation-owned parameters join the same cleanup plan as locals,
including conditional transfer, failure, and void fallthrough.

Synchronous borrowed cleanup-bearing captures now address their owner's storage
without retaining, moving, or dropping it at callback exit. Exact cleanup and
allocation probes cover replacement, typed failure, nested forwarding, and
conditional invocation through both emitters.

The restricted synchronous body audit now additionally checks borrowed String and
custom-cleanup local captures, locally handled typed errors, and availability
through base/receiver aliases and both borrowed and owned callbacks. It closed two
parity gaps: native checking admitted `async scope` in a synchronous body, and
Stage 0 admitted consuming Objective-C calls through base-typed aliases in native
subclass bodies. The latter now has the same lexical restriction as native
checking, including nested callbacks and non-variadic call requirements. Neither
fix introduces a new source rule. Native async-scope validation follows the
innermost function/closure context, not an outer async function.

The real Objective-C execution fixture now borrows a dynamically allocated String
inside a custom-cleanup method local. A native balance counter must return to zero
after every iteration, in addition to exact native object destruction. This is
paired Stage 0/native execution evidence as of the executable-body checkpoint.

Native class-entry planning now preserves module-qualified generated identity,
the imported superclass identity/header, main affinity, source constructor/method
locations, exact override ABIs, unavailable inherited designated initializers,
and typed superclass dispatch sites. Constructor parameter ABI is derived from
the source signature, independently of arguments passed to `super.init`.
Planning checks every superclass site's typed evidence against the inherited
native declaration; missing evidence, ordinary-dispatch substitution, or changed
native return/parameter types fail closed.

The native C-family emitter can independently emit these plans' interfaces.
Strict Clang tests cover zero/multiple constructor arguments, native records and
enums, inherited bases, selector aliases, multiple source classes, and borrowed
native object parameters without adding a pointer indirection. No implementation,
constructor wrapper, or Z ARC record is generated by this declaration-only probe.
This interface-only checkpoint was followed by the executable body checkpoint
below. Ordinary aggregate lowering still rejects manually assembled subclass ASTs
without checked native plans, so bypassing the resolver cannot silently select
the wrong representation.

The approved lifecycle gate, reentrant loan enforcement, bounded inline state,
and strong native-resource storage are implemented and tested. Before moving
Zapp's transition state into a subclass, deliberate the new callback-selector
declaration and typed target/selector registration boundary. The resource audit
establishes explicit display-link invalidation during live close/shutdown.
General async closure completeness is **not** a prerequisite for this bounded,
synchronous native subclass tier. Unsupported suspension remains rejected rather
than expanding this Zapp-driven task into a general async implementation project.

Planning checkpoint (2026-09-10): approximately 3–5 focused compiler/design
checkpoints to begin Zapp integration, then 1–3 integration and user visual-validation
checkpoints. These are scope estimates, not calendar promises. The state/lifetime
design review is the largest uncertainty, and any new API or syntax is a user
deliberation point before implementation.

Update after executable native bodies: the field-free port and differential
execution gates below are complete, including a freshly bootstrapped NSWindow
compile-only probe. Next is the user review of subclass-owned state and callback
lifetimes, then implementation/teardown tests and the Zapp resize integration.
The earlier range included the now-completed native body port. The lifecycle
review, forwarding gate, reentrant entry enforcement, and bounded inline owned
storage are now complete, including strong imported native object fields. Next,
review the actual display callback's declaration/registration contract, then
return to production integration; do not use this checkpoint as a reason to
expand unrelated subclass features.

The field-free native port was bounded by four gates:

1. **Complete:** carry raw safety facts through native foreign normalization and
   module signatures, without exposing unsupported native ABIs as callable.
2. **Audited restricted tier:** declaration contracts, structural receiver/initialization
   rules, superclass call/capture checks, nominal receiver identity, first
   argument/result/property typing, imported executor capability validation,
   alias-exclusivity tests, and target-aware Objective-C availability errors are
   present. Synchronous cleanup-bearing local/capture compositions, local error
   handling, alias/callback availability, and rejected consuming/suspending
   operations now have paired checker coverage. This does not establish support
   for every expression or reentrant native call; unsupported executable shapes
   must still fail closed during lowering.
   Executable plans must require attached ABI evidence; the source-only
   declaration deferral must never become a successful execution path.
3. **Complete:** lower checked constructor/super calls and native method entries into explicit
   IR, then emit native interfaces/implementations and ARC construction without
   a Z wrapper. Keep generated symbols inaccessible through raw source.
4. **Complete:** run the same virtual-dispatch, superclass, alias, construction, and exact
   destruction fixture through a freshly built native compiler; only then remove
   the native `Z0814` implementation boundary.

### Executable native bodies (2026-09-10)

The checked plans remain separate from ordinary Z ARC aggregates. Dedicated IR
operations emit constructor wrappers, real Objective-C entries, and lexical
`super` dispatch. The resolver's blanket execution gate is removed; unsupported
body shapes retain their normal checker/lowerability diagnostics.

The implementation preserves these invariants:

- Build subclass body evidence and `objectiveCSubclasses` plans before appending
  ordinary function evidence, without copying ownership-bearing lookup maps or
  discarding the subclass checks.
- Lower source subclass values as native Objective-C references with nominal
  source identity, not as `LoweredStruct.referenceType` Z records. Keep native
  constructors/method entries and `objcSuperInitializer` / `objcSuper` operations
  explicit while reusing ordinary synchronous expression/cleanup lowering.
- Emit `self = [super init...]`, nil/replacement-class checks, main-entry guards,
  and native allocation/construction. Verify generated-symbol hygiene in the
  standalone native path before allowing raw source in executable subclass bodies.
- Use the real native fixture for differential execution. It covers native
  virtual and superclass calls, selector aliases, inherited property writes,
  nested constructor closures, borrowed cleanup-bearing method locals, and owned
  native captures that outlive the constructing function.

That lifecycle oracle found a general native-emitter bug: heap closure environments
with strong Objective-C fields were allocated uninitialized and freed without
clearing those fields. Such environments now start with nil slots and clear each
owned reference before free. Non-Objective-C environments retain their existing
allocation path. This is an implementation fix, not a new ownership rule.

Raw native functions cannot name this compilation's generated subclass or
constructor symbols (`Z0820`); legitimate native names such as `Z_OK`, comments,
and string literals remain accepted. This protects internal ABI hygiene, not a
sandbox against arbitrary raw native code. Owned-field initialization/cleanup,
reentrant field loans, and production Zapp integration remain separate
implementation/validation checkpoints under the approved lifecycle direction.

## References

- [Current Objective-C interop](interop-model.md)
- [Apple: NSWindow animationResizeTime](https://developer.apple.com/documentation/appkit/nswindow/animationResizeTime(_:))
- [Apple: object initialization](https://developer.apple.com/library/archive/documentation/General/Conceptual/CocoaEncyclopedia/Initialization/Initialization.html)

The Apple initialization reference includes manual-retain/release examples;
Z's native implementation must use modern Objective-C ARC rules, not copy those
manual ownership calls.
