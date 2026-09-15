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
- public stored fields, storage beyond scalars/plain native values/owned `String`,
  strong imported Objective-C references, and weak Z-class handles; escaping
  field loans, weak references to native subclasses themselves, and
  protocol/trait composition;
- asynchronous, throwing, consuming, static, generic, block-receiving, or
  object-returning overrides, plus variadic native signatures;
- native lifecycle/runtime overrides, direct (`objc_direct`) methods, consuming
  native ownership contracts, and explicit manual ARC lifecycle calls;
- methods marked `NS_REQUIRES_SUPER` until path validation exists;
- capturing `super`, treating it as a value, or using it outside the native class;
- transferring native subclass identity through `thread.spawn` (including as
  an opaque main-isolated capture). Ordinary Z executor-bound classes have a
  separate transfer mechanism; it is not native Objective-C ARC.

Synchronous native subclasses may coexist with async Z code. Construction,
native method calls, and checked property getters work in Stage 0 task frames;
the native compiler preserves the same Objective-C identity through its
supported main-isolated timer and continuation frames. Owned parameters and
local references, including references inside value structs, retain the native
object until completion or cancellation. This does not enable async overrides
or relax executor checking.

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

The utility references the method declaration, not a receiver instance. It
neither invokes the method nor creates
a closure. The compiler must preserve receiver/signature evidence through the
checked registration boundary before emitting the ordinary native `SEL`.
No raw string-to-selector conversion is implied. Existing inherited overrides
continue to use `override function ... as "selector:"`; a new native
callback uses `function ... as "selector:"` without `override`. New entries now
execute in both compilers. A collision with an inherited selector requires
`override`, rather than silently replacing it.

Both compilers parse and validate the declaration below and preserve the
target/signature evidence through executable registration. The first tier
requires `objc.selector(Type.method)` inline in the contracted selector argument.
A stored/bare `SEL`, string, bound instance method, or ordinary method call
cannot substitute for that evidence. First-class stored selector evidence is
not part of this tier.

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
The executable slice checks the referenced method's signature and the target's
receiver type against that assertion. This is not an independently Clang-verified callback
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
shutdown. Known constructing/dying receiver aliases are rejected at registration;
an additional direct native readiness check runs before the target reaches the
native call, including through an indirect helper. It creates no object or
closure. It does not take an exclusive loan over the target's stored fields.
An unexpected new-selector invocation outside Ready must fail closed rather
than forward to a nonexistent superclass implementation.

The independent native contract decoder checks the same malformed contracts as
Stage 0 using raw Clang declarations, including target kind, argument names,
capabilities, missing facts, and executor requirements. `.zd` completion and
hover explain the trust boundary rather than describing a closure environment.
Next: real resize integration. Native reentry during AppKit superclass operations
is a concrete integration test, not permission to weaken the approved guard.

### Implemented new native entries

```zs
function onDisplay(
  inout this,
  in link: QuartzCore.CADisplayLink
): void as "display:" {
  const timestamp = link.timestamp;
}
```

Inside a main-isolated native subclass, this declares a new Objective-C method
with a source-declared ABI. It does not register a callback or create a `SEL`
value. Ordinary Z calls and native dispatch enter the same checked method.
The first tier accepts scalar/native-enum values and borrowed concrete imported
object parameters, with scalar/enum or `void` results; transparent aliases work.
Labels must match the parameter count. Nullable objects, aggregate parameters,
object results, async/throwing bodies, and consuming receivers remain rejected.

A new selector has no superclass fallback: entry before Ready or during teardown
traps before the Z body. Main-thread and shared/exclusive receiver checks are
identical to overrides, including retaining access through local cleanup.
Native plans carry an explicit inherited-entry flag through lowering so emission
cannot silently invent superclass dispatch. No adapter or closure is allocated.

The independent native emitter and Stage 0 each pass 200 lifecycle iterations
at `-O0` and `-O2` under strict Clang/UBSan. Expected construction, teardown,
wrong-thread, and conflicting reentry traps are caught without crash reports.
An actual AppKit subclass with a borrowed `CADisplayLink` callback also passes
compile-only validation. Live display-link and WebView integration are covered
by the later [application checkpoint](#display-link-integration-checkpoint-2026-09-11).

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
The checked delegation boundary below temporarily releases only the delegating
entry's access; it does not exempt the callback from this check.
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

#### Real AppKit reentry checkpoint (2026-09-10)

The manual `scripts/probe-appkit-subclass-reentry.ts --run` probe establishes
that this conservative rule blocks the intended Zapp zoom controller. A new
exclusive native entry invokes `super.zoom(null)`; AppKit dispatches virtually
to the same receiver's `setFrame:display:animate:` override, which is another
exclusive entry. The guard rejects it before that second Z body runs. This is
ordinary superclass behavior, not a background-thread race or an escaping loan.

The direct animated `setFrame` control completes on the tested macOS; it did
not demonstrate the same reentry. A second control removes both source writes
and makes both entries readers; zoom then completes. That control cannot be
used as a mutable animation implementation. Both generated variants are run
at `-O0` and `-O2` under strict Clang/UBSan, with ten-second process deadlines
and caught expected aborts. The GUI probe is opt-in, not an ordinary CI test.
It establishes dispatch behavior, not WebView smoothness or zoom/restore
correctness. The test suite separately checks the fixture without opening a GUI.

This initial result motivated the subsequently approved, implemented checked
delegation boundary below. The same six manual cases now complete; the initial
failure remains useful evidence for why whole-entry exclusivity alone was too
restrictive for ordinary native superclass behavior.

The erased native sender is now source-nameable as `objc.Object | null`, and
borrowed sender delegation is supported below. The separate blanket rejection
of subclasses in async programs has also been removed. Native subclasses stay
Objective-C objects in async storage, not ordinary Z ARC classes. The general
native async lowering boundaries still apply: main-isolated timer bodies and
supported continuation bodies are distinct tiers, not arbitrary suspension
composition. See the ownership-pressure checkpoint for the remaining probes.

#### Checked synchronous superclass delegation (2026-09-11)

Both compilers automatically hand off the current entry's receiver access for
a checked synchronous, nonconsuming `super` call when it is the entire expression
of a statement, local initializer, or return. It accepts scalar, enum, and plain
native record arguments/results, plus native object arguments (including
nullable erased `objc.Object`). Each object argument becomes a precisely scoped
strong ARC snapshot before delegation, whether sourced from an `in` parameter,
an owned local, `this`, or a field value. This copies reference identity, not the
object or a loan into its source storage. Constructors, nested expressions,
writable/output arguments, blocks, raw pointers, consuming calls, and other
cleanup-bearing values remain outside this tier. Ineligible calls keep the
original guard or are rejected; there is no blanket `super` bypass or new syntax.

```zs
override function zoom(inout this, in sender: objc.Object | null): void as "zoom:" {
  this.changes = this.changes + 1;
  super.zoom(sender); // AppKit may reenter a guarded Z setFrame override here.
  // Receiver access has been reacquired before this continuation.
}
```

The compiler rejects live receiver-field loans at an eligible boundary. Current
native subclass field views are already conservatively rejected; this does not
add field-borrowing support. Arguments are evaluated and materialized under the
original guard before delegation. Only that entry's access is released, not the
receiver's entire access count: another active reader still prevents a writer.
The existing precise-lifetime receiver hold remains active. Access is reacquired
immediately after native return, before Z resumes or argument/body-local cleanup
runs. Object argument temporaries use `objc_precise_lifetime`: their final
release cannot move ahead of reacquisition, even in optimized code. A native
destructor that reenters at that point is subject to the restored guard.

This is a possible mutation boundary, not an atomic operation. A copied scalar
or retained object local is a snapshot; reentry may replace the field it came
from. Current flow narrowing applies to named locals, not receiver fields, so
fresh field reads still use their declared type. Any future field-based flow
facts must be invalidated here.

The handoff adds a small stack token and release/reacquire checks, but no new
heap allocation or receiver hold beyond the existing entry guard. Object
arguments add ordinary ARC retain/release work; this is intentional lifetime
safety, not a zero-cost claim. Its cost has not been benchmarked.
Differential strict-Clang/UBSan tests at `-O0` and `-O2`
cover reader/writer delegation, value/void returns, snapshots, final outside
owner release, restoration, guarded argument evaluation and local destruction,
nested readers, borrowed/nullable/receiver-alias object arguments, field snapshot
survival and exact cleanup, argument-destructor reentry, and excluded call
shapes. Missing or contradictory native object-lifetime evidence is rejected.
The AppKit runner accepts `--check` for strict Clang validation without opening
windows, or explicit `--run` in a GUI session. Add `--native` to exercise the
freshly bootstrapped compiler rather than Stage 0.

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
imported Objective-C references (including `NativeClass | null`), and `Weak<T>`
or `Option<Weak<T>>` where `T` is an ordinary Z class. Other storage
shapes fail closed; this does not yet promise arbitrary ARC/resource graphs.

A native window can therefore hold a weak Z observer while the observer holds
the window strongly. Borrow an optional handle with
`match (in this.observer) { some(handle) => ...; none => ...; }`; `handle.upgrade()`
uses the existing checked weak-reference result. Direct weak-handle snapshots
retain the weak control block, not the observer. Replacement and automatic
field destruction release those handles, including when no source `deinit`
exists. This is not native Objective-C weak-reference support.
See `tests/fixtures/objc-subclass-weak-state.zs` and the
[managed-state/helper checkpoint](native-subclass-z-state-design.md).

Synchronous instance methods without `as` are ordinary Z-only methods,
not native selectors. Normal public, `internal`, and private visibility applies;
an external Z owner can install a weak observer through a public/package method.
They can accept/return ordinary managed Z values, including
`Weak<Observer>` and `Option<Observer>`. Direct nested `this` calls reuse the active shared/exclusive
receiver loan; another receiver binding acquires its own guard, including if it
aliases the current native object. Helper locals finish cleanup while access
and receiver lifetime remain protected. `objc.selector` rejects these helpers.
Throwing, async, consuming, static, generic, constructor/deinit helper calls,
and `super` inside helpers remain outside this tier. The executable pressure
fixtures are `tests/fixtures/objc-subclass-private-helpers.zs` and
`tests/fixtures/objc-subclass-z-methods.zs`.

Every field must be assigned once in a straight-line prefix immediately after
`super.init`, before other receiver use or control flow. Initializer expressions
may call ordinary free functions but cannot inspect the partially initialized
receiver or call its Z-only methods. The
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

## Display-link integration checkpoint (2026-09-11)

The [real Z controller](../examples/interop/objc/smooth-window/README.md) now
combines the approved native subclass, private state, checked selector, and
superclass handoff. Both emitters pass seven bounded AppKit geometry/cleanup
scenarios at `-O0` and `-O2`, including interrupted zoom/restore, immediate
interruption, close, and Reduce Motion. Forward-declared return objects and
selector signatures now compose across AppKit/QuartzCore imports using the
existing native class identity, with no new language surface.
The actual WebView path is checked separately for readiness, intermediate
viewport layout, and clean `NSApplication.run` shutdown in both emitters and
optimization modes. The user-caught unresponsive demo exposed an inadequate
Foundation-only event-loop harness, not a reason to accept geometry tests as
proof of an interactive application.

This supersedes the earlier integration-blocker notes as a progress checkpoint,
not as a claim that every native async shape is implemented. Zapp still creates
ordinary NSWindow instances. User visual validation and the real framework's
delegate/constraint/shutdown integration are next. System-owned transitions and
event coalescing remain distinct work. See the current ownership-pressure log
for surfaced cross-header record and native lowering limitations.

## Wails correctness follow-up (2026-09-11)

Rechecking Wails [#5856](https://github.com/wailsapp/wails/pull/5856),
[#5900](https://github.com/wailsapp/wails/pull/5900), and
[#5945](https://github.com/wailsapp/wails/pull/5945) separated the demonstrated
viewport improvement from the remaining native-state invariants. The Z probe
now prepares AppKit's target before interpolation, reports intended `isZoomed`
state during a transition, preserves a separate user restore frame, updates it
on later nonstandard-frame size changes, and rechecks Reduce Motion on ticks.
No-screen and equal-frame requests do not create an animation source.

Twelve bounded geometry scenarios pass through both emitters at `-O0` and `-O2`
(48 runs, strict Clang/UBSan). They include moved-maximized restoration, updated
manual restore geometry, and injected mid-transition accessibility/no-screen
conditions; they do not modify the user's system preferences. AppKit may first
maximize a moved nonstandard frame again; tests preserve that native decision
and verify the eventual restore, rather than require a one-click policy.

**Resolved design gate:** `==`/`!=` compare compatible class references by object
identity, non-consumingly and without an `isEqual:` dispatch. The controller now
checks `link != active`. A thirteenth scenario manually delivers a distinct,
unscheduled display link while a real animation is active and verifies that
the stale source cannot advance or cancel it. Zapp cutover is the next step;
framework menu/delegate/constraint/shutdown validation is not implied by the
standalone geometry or WebView checks.

## References

- [Current Objective-C interop](interop-model.md)
- [Apple: NSWindow animationResizeTime](https://developer.apple.com/documentation/appkit/nswindow/animationResizeTime(_:))
- [Apple: object initialization](https://developer.apple.com/library/archive/documentation/General/Conceptual/CocoaEncyclopedia/Initialization/Initialization.html)

The Apple initialization reference includes manual-retain/release examples;
Z's native implementation must use modern Objective-C ARC rules, not copy those
manual ownership calls.
