---
title: Objective-C interop
description: Use AppKit and other Objective-C frameworks directly while making ARC, protocols, target/action, and main-thread rules explicit.
sidebar:
  order: 6
---

Ordinary Objective-C starts with an ordinary header import:

```z
import AppKit from "AppKit/AppKit.h";

const app = AppKit.NSApplication.sharedApplication;
const frame = AppKit.NSMakeRect(0.0, 0.0, 800.0, 600.0);
const window = AppKit.NSWindow.alloc().initWithContentRect(
  frame,
  styleMask: AppKit.NSWindowStyleMaskTitled,
  backing: AppKit.NSBackingStoreBuffered,
  defer: false
);

window.title = "Native Z";
window.center();
window.makeKeyAndOrderFront(null);
app.activate();
app.run();
```

Classes, methods, properties, constants, inheritance, nullability, and ARC
identity come from Clang. `std/objc` is not required for ordinary message sends.

Objective-C identity follows the Clang runtime name rather than the header or Z
namespace that surfaced it. If Foundation and a vendor header both mention
`NSString`, they describe the same nominal native class—no wrapper or cast is
introduced. A non-null Z `String` can satisfy either a non-null or nullable
`NSString` argument while remaining non-null itself.

An inferred object returned through a forward declaration gains its checked
members when you import the complete class header. For example, AppKit returns
`CADisplayLink`, while `QuartzCore/CADisplayLink.h` defines its run-loop methods.
You do not need a cast or a redundant local type annotation. Selector callback
signatures also recognize the same native class across these imports, without
weakening nullability or capability checks.

## ARC identity remains explicit

Imported Objective-C objects behave as shared reference identities. Assigning
or storing one applies the imported ownership convention and generated ARC
retains/releases. Nullable native references remain `T | null` and must be
narrowed before use.

Header availability annotations do not erase nullability. For example,
`NSStatusItem.button` remains `NSStatusBarButton | null`, including in hover,
even when Clang spells its type through an availability macro. Check it before
setting the image or tooltip. Implicit property accessors preserve the same
contract.

Arrays of Objective-C references and `objc.Connection` guards own their elements.
Growing their storage preserves ARC ownership; clearing or destroying the array
releases those elements and their callback environments.

Short-circuit guards preserve that proof for the expression to their right:

```z
const title: Foundation.NSString | null = window.title;

if (title != null && title.isEqualToString("Ready")) {
  const owned: String = title;
  publish(move owned);
}
```

Dynamic `id` does not become a Z `any`. Narrow with a native class test:

```z
const body = message.body;

if (body instanceof Foundation.NSString) {
  const text: String = body;
  route(move text);
}
```

`instanceof` lowers to the Objective-C runtime class check. Converting the
narrowed `NSString` to an explicit Z `String` makes an owned UTF-8 copy with its
exact byte length.

### Naming an unknown native class

Use `objc.Object` when a signature needs Objective-C's erased `id` reference:

```z
import objc from "std/objc";
import Foundation from "Foundation/Foundation.h";

function textLength(in value: objc.Object | null): usize {
  if (value instanceof Foundation.NSString) {
    const text: String = value;
    return text.byteLength;
  }
  return 0;
}
```

`objc.Object` is non-null; `objc.Object | null` also admits `nil`. A null guard
narrows the latter to the former, but does not prove a particular class.
`instanceof` supplies that class proof before member access or `NSString`-to-Z
`String` copying. Module aliases and exported type aliases preserve the same
native identity.

This is native `id`, not `NSObject *`: alternate-root objects such as `NSProxy`
are included. It is not a Z `any`, a raw pointer, or a constructible class.
Ordinary Z values cannot be assigned to it; convert a Z string to a concrete
`NSString` first when that bridge is intended. Erasing the class adds no wrapper
allocation or deep copy. Owned bindings still have normal native ARC costs;
`in` borrows a reference. It grants no cross-thread transfer or executor-access
permission.

Inherited native overrides can now name a nullable sender accurately:

```z
override function zoom(inout this, in sender: objc.Object | null): void as "zoom:" {
  super.zoom(sender);
}
```

For this checked synchronous full-expression delegation, the compiler keeps a
strong ARC snapshot of `sender`, then releases only the current receiver entry's
access. It restores access before releasing the snapshot. Native reentry can
therefore reach a guarded override without turning the sender into an escaping
storage loan. Synchronous native subclasses can also live in supported async
task frames; their methods do not become async and native-object thread transfer
stays restricted.

String bridging also composes with conditional values:

```z
const reply: Foundation.NSString = accepted ? "accepted" : "rejected";
const snapshot: String = reply;
```

The selected String result crosses the native boundary; the boolean condition
does not. Converting back to `String` creates an independent owned UTF-8 copy.

## Main-thread requirements enter the type system

Imported Apple metadata and reviewed API notes can mark declarations
`on thread.main`. A call from an unproven executor is rejected before native
compilation.

```z
import { thread } from "std/thread";

async function publish(in window: AppKit.NSWindow): void {
  await on thread.main window.makeKeyAndOrderFront(null);
}
```

The placement is useful even when the function may be called from different
executors: the call site proves where the native operation runs rather than
depending on a convention in documentation.

## Native subclasses (experimental)

A protocol adapter does not become an `NSWindow`. When native virtual dispatch
is required, the first subclass tier creates a real native ARC object:

```z
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

  override function animationResizeTime(frame: AppKit.NSRect): f64
    as "animationResizeTime:" {
    return super.animationResizeTime(frame);
  }
}
```

Import AppKit and `thread` as above, then construct with `new SmoothWindow(frame)`.
The override shown preserves the superclass behavior; it does not implement a
resize algorithm. The compiler checks the inherited selector and ABI. `super`
invokes the superclass implementation on the same object. There is no separate
Z ARC allocation or protocol-adapter wrapper.

The superclass designated initializer must be first and non-nullable. Generated
code checks the returned identity and the main thread, without scheduling a hop.
Its generated constructor helper explicitly transfers an owned native reference;
`new` does not defer that ownership to an enclosing autorelease pool.
Virtual calls during construction and destruction invoke the superclass, **not**
the Z override. Z overrides become active only after the constructor body and
its local cleanup finish, including cleanup of native ARC temporaries. This also
applies to `this.method()` calls from the constructor after `super.init`.
It is Z's deliberate lifecycle rule, not ordinary Objective-C dispatch; libraries
requiring subclass callbacks during initialization need a later explicit tier.
The gate adds one byte-sized native field (plus possible layout padding) and an
entry branch, not another heap object.

Ready entries also enforce receiver exclusivity across native callbacks. Nested
`in this` reads are allowed; reentry involving an active or incoming `inout this`
traps before the conflicting Z body runs. This is a nonblocking contract check,
not a lock or executor hop. Virtual callbacks made by a superclass check the
same access rule.

Access remains held during local cleanup, including ARC destructors and early
returns. A scoped strong native reference keeps the receiver alive through the
check's cleanup. The current cost is one additional pointer-sized native field,
a stack guard, entry/exit checks, and a native retain/release—not another heap
allocation. This conservative safety tier is not zero overhead.

There is one checked delegation exception: a synchronous `super` call used as
a whole statement, local initializer, or return can temporarily release the
current entry's access. It permits scalar, enum, and plain native record values,
plus native object arguments, including borrowed nullable senders and field
references. Arguments are evaluated first while guarded; object references get
precise-lifetime strong snapshots; the receiver stays alive; access is restored
before argument destruction, Z continuation, or local cleanup. Other active
readers remain protected. This lets AppKit's `super.zoom(sender)` reenter a
mutable `setFrame` override without disabling its guard. Nested expressions,
blocks, and writable arguments remain outside the tier, and live receiver-field
storage loans are rejected.

Reentry may change fields. Retained or copied locals remain snapshots, not
proof that the receiver is unchanged. This boundary adds stack state and access
checks plus native ARC retain/release for object arguments, not another heap
allocation.

Synchronous native subclasses can coexist with async Z programs. Their identity
remains a native Objective-C reference in task storage, including owned
parameters and references inside value structs. Supported main-isolated timer
and continuation frames retain that identity across suspension and release it
on completion or cancellation. No extra Z object wrapper is allocated.
Subclass methods themselves remain synchronous and main-isolated; this does not
enable native-object transfer through `thread.spawn` or remove the native
compiler's broader async composition limits.

Private stored scalars, imported enums/plain native records, owned `String`, and
strong imported Objective-C references are supported. They live inline in the
native object, not a second wrapper. Native reference fields may be nullable:
`private link: QuartzCore.CADisplayLink | null;`.
Initialize every field directly after `super.init`, before other receiver use or
control flow. Access is direct `this.field` inside a guarded entry; writes require
`inout this`. Copy snapshots when a value needs to outlive the entry.
Native reference snapshots retain identity; clearing the original nullable
field with `null` does not destroy another retained snapshot. Native field
replacement remains protected against reentrant receiver access.

Existing `deinit { ... }` runs after the readiness gate closes. Its local cleanup
finishes before automatic reverse-order field cleanup. You may inspect/copy
fields during teardown, but cannot publish or call through dying `this`, and
must never call `super.dealloc`. Automatic cleanup also works without `deinit`.
Strong fields are cleared before superclass teardown. For registrations such as
display links, explicitly invalidate during close/shutdown: ARC cannot break a
cycle that prevents `deinit` from running, and Z does not infer native shutdown
methods from an object's type.
See the [stateful compiler fixture](https://github.com/popaprozac/z/blob/main/tests/fixtures/objc-subclass.zs)
for construction, replacement, and cleanup examples.

For an application-shaped example, the
[display-driven window probe](https://github.com/popaprozac/z/tree/main/examples/interop/objc/smooth-window)
implements an AppKit zoom/restore controller in Z, with private geometry state,
checked display-link registration, retargeting, and explicit close-time
invalidation. It uses AppKit's full application event loop and removes its close
observer after the loop returns. Bounded tests in both compilers cover native
geometry/cleanup and real WebView readiness, intermediate viewport layout, and
shutdown. Visual presentation quality and framework integration remain separate
from those tests.
The correctness follow-up covers intended zoom state, saved user restore frames,
and Reduce Motion changes during a transition. The `link != active` guard
distinguishes a stale display-link callback from the current source, even during
a newer animation.

Native behavior remains part of the contract: if `windowShouldZoom:toFrame:`
vetoes a request, an unchanged target must stay unchanged—even when the Z
controller has a saved restore frame. The probe tests that case before both
zoom and restore. Compiler ownership checks do not replace these platform
semantics tests.

`==` and `!=` on compatible native class references compare **object identity**,
without consuming either reference or calling `isEqual:`. Same-class,
base/derived, erased `objc.Object`, and nullable reference comparisons are
supported; unrelated concrete classes are rejected. A native `NSString` uses
identity here, whereas Z `String` uses UTF-8 content equality. Comparing two
named references needs only a pointer comparison; nontrivial operands keep
temporary references alive through the comparison and clean them up afterward.

Nullable `instancetype` factories preserve both the receiver's class and the
possibility of `null`, including inherited factories. Check the result before
accessing members; for example, `NSURL.URLWithString(...)` may return `null`.

### New native callback methods

A native subclass can also introduce a method that the superclass does not have:

```z
function onDisplay(
  inout this,
  in link: QuartzCore.CADisplayLink
): void as "display:" {
  const timestamp = link.timestamp;
}
```

Use `override` only for an inherited selector; omitting it for an inherited
selector is an error. New methods use a checked source-declared ABI. This tier
supports scalar/enum values and `in` concrete imported object parameters, with
scalar/enum or `void` returns. Parameter labels must match the selector.

New entries enforce the same main-thread and receiver-exclusivity checks as
overrides. Before Ready or during teardown they trap—there is no superclass
method to forward to. No adapter or closure allocation is introduced.

This declaration does **not** register a display link. With an adjacent
[selector callback contract](/interop/z-declaration-contracts/), registration
uses an explicit declaration reference:

```z
import objc from "std/objc";

const link = window.displayLinkWithTarget(
  window,
  selector: objc.selector(SmoothWindow.onDisplay)
);
```

The first tier requires the reference inline at the contracted call. Z checks
the method signature, visibility, target type, and main context; it does not
call the method, capture a receiver, or allocate a closure. Known
constructing/dying target aliases are rejected, and a direct Ready check runs
before registration even through a helper. A bare `SEL` cannot bypass this.
Native ARC retention remains native behavior. Add the display link to the main
run loop for delivery, and explicitly invalidate it during live shutdown to
break any target/link cycle. Registration itself does not schedule a hop.

Broader owned resource fields, escaping field views/captures, `Weak`, fallible
constructors, object-returning or async overrides, and general suspension
composition remain future work. Ordinary Z-to-Z inheritance is not supported. Both the TypeScript
Stage 0 compiler and the native compiler execute this tier. The native frontend parses these declarations
and checks imported declaration contracts, including restricted bases, inherited
override signatures, and designated/nonnullable initializer selection. Structural
checks also reject repeated initialization, receiver use in initializer
arguments, captured or extracted `super`, and constructor returns hidden in
expression blocks. A nested closure may still return to its own caller. The
first native body-typing tier checks names, argument/result types, inherited
properties, nominal base conversions, and receiver alias exclusivity using the
ordinary checker. It also requires the imported `thread.main` capability.
Native Objective-C references retain shared identity on ordinary assignment;
explicit `move` does not apply to these references. Direct `this` capture is
still outside the initial closure tier. A named alias can be retained in a typed
owned closure, with the appropriate executor contract. Runtime tests verify that
such a callback keeps the native receiver alive until the callback is destroyed.
Native subclass checks also use the existing `z.json` deployment target to reject
unavailable APIs and APIs introduced after, or obsoleted by, that minimum version.
This includes superclass declarations, overrides, calls, and properties. Other
platforms' restrictions are ignored. Without a configured minimum, version checks
remain deferred just as in Stage 0; platform-only unavailability still applies.
The native checker also rejects borrowed captures becoming owned function
values, including through generic arguments, containers, returns, and nested
owned captures. Both frontends also check a known synchronous Z helper's body
before passing it a stack-backed callback. Direct invocation and proven named
forwarding remain supported; returning, storing, or capturing the callback
requires an owned environment at the call site. This does not forbid retaining
received Objective-C blocks whose adapters supply ARC-backed retain/release hooks.
Native deprecation warnings remain pending.
Dedicated native lowering emits real method entries and constructor wrappers,
not a Z ARC record. The same 200-iteration dispatch and lifetime fixture passes
both compilers at `-O0` and `-O2` under strict Clang checks and UBSan, including
construction/teardown callbacks and constructor-local ARC cleanup. Owned native captures keep
their receiver alive until the closure's final release. Internal generated class
and constructor names, plus lifecycle and owned-field storage, cannot be referenced from raw source. This is a bounded
storage checkpoint, not support for arbitrary resource graphs or general async bodies.

## Own target/action connections

AppKit controls commonly expose a weak target plus selector. Binding only the
target would make closure lifetime a hidden footgun, so `std/objc` turns the
relationship into one owned token:

```z
import objc from "std/objc";

const connection = objc.connect(button, move () => {
  saveDocument();
});
```

`objc.connect` installs a generated adapter and returns `objc.Connection`.
Keep that value alive for as long as the action should fire. Its cleanup clears
the installed target/action before releasing the control and closure
environment. Discarding the connection is a compile-time error.

## Implement imported protocols

A Z class can implement Objective-C protocols without becoming an Objective-C
class itself:

```z
class TableController implements
  AppKit.NSTableViewDataSource,
  AppKit.NSTableViewDelegate
{
  function rowCount(
    in tableView: AppKit.NSTableView
  ): isize as "numberOfRowsInTableView:" {
    return 0;
  }

  function viewForRow(
    in tableView: AppKit.NSTableView,
    in tableColumn: AppKit.NSTableColumn | null,
    row: isize
  ): AppKit.NSView | null as "tableView:viewForTableColumn:row:" {
    return null;
  }
}
```

The `as "selector:"` clause is checked against the imported protocol
requirement. `objc.bind` installs generated adapters into weak delegate or data
source properties and owns their lifetime:

Protocol-qualified callback values keep their native protocol surface:

```z
function start(
  in webView: WebKit.WKWebView,
  in task: WebKit.WKURLSchemeTask
): void as "webView:startURLSchemeTask:" {
  task.didFinish();
}
```

The first tier borrows `task` only for the synchronous callback. Z rejects
storing, returning, or suspending with it, while hover and autocomplete expose
the imported `WKURLSchemeTask` methods.

Received Objective-C blocks are typed Z callables:

```z
function decide(
  in webView: WebKit.WKWebView,
  in action: WebKit.WKNavigationAction,
  in decisionHandler: (policy: WebKit.WKNavigationActionPolicy) => void
): void as "webView:decidePolicyForNavigationAction:decisionHandler:" {
  decisionHandler(WebKit.WKNavigationActionPolicyAllow);
}
```

`in` expresses the callback-time borrow. Stage 0 can copy the function value
into owned Z storage, where its ARC bridge retains the native block safely.
The fixed-point backend currently executes synchronous invocation and rejects
explicit callable copy, preserving the non-escaping boundary.

Imported completion-handler parameters accept captured Z closures directly:

```z
webView.evaluateJavaScript(
  move source,
  completionHandler: move (value, error): void => {
    if (error != null) report(error);
  }
);
```

The compiler uses the exact imported block ABI, keeps the closure environment
alive under ARC, and preserves nullable Objective-C values for ordinary Z
narrowing. Both incoming and outgoing block adapters run through Stage 0 and
the fixed-point native compiler.

Z byte storage can become independently owned Foundation data explicitly:

```z
const bytes = Array<u8>(90, 32, 68, 97, 116, 97);
const data = Foundation.NSData.copy(bytes);
```

`copy` accepts `Slice<u8>`-compatible storage, evaluates it once, and performs
one native byte copy into ARC-managed `NSData`. The source remains owned by Z;
no source lifetime escapes into Foundation.

An embedded asset has a stronger, process-lifetime proof and can use the
zero-copy bridge:

```z
import embed from "std/embed";

const icon = embed.bytes("./assets/icon.png");
const data = Foundation.NSData.borrow(icon);
```

`NSData.borrow` accepts only nominal `embed.StaticBytes`. Foundation does not
copy or free the binary's immutable static storage. Ordinary Arrays and Slices
must use `NSData.copy`.

```z
const controller = new TableController({});
const binding = objc.bind(tableView, {
  dataSource: controller,
  delegate: controller,
});
```

Some APIs retain or store an `id<Protocol>` argument directly rather than
exposing a weak property. Use `objc.adapt` to create an owned protocol carrier:

```z
const handler = new SchemeHandler({});
const adapter = objc.adapt<WebKit.WKURLSchemeHandler>(handler);

configuration.setURLSchemeHandler(
  adapter,
  forURLScheme: "zapp"
);
```

The handler must be a stored Z class implementing the exact imported protocol.
The result is `objc.Adapter<WebKit.WKURLSchemeHandler>`, which can be stored in
an ARC class field. Its native representation is exactly
`id<WKURLSchemeHandler>`: one generated `NSObject` adapter retains the Z
controller, and normal ARC retains that adapter. Passing an adapter for a
different protocol is a compile error.

Imported protocol values also widen safely from `id<P>` to an Objective-C
method parameter typed as ordinary `id`. This is a zero-cost native widening,
not a wrapper or unchecked cast. Free C functions whose signatures directly
contain Objective-C objects or `id<Protocol>` remain outside the checked
header-only function tier for now; prefer an imported Objective-C method or a
reviewed declaration at that boundary.

This first tier is conservatively `thread.main`-bound. It is distinct from
`objc.bind`, which owns adapters installed in zeroing weak properties, and from
`objc.register`, which owns a checked add/remove lifetime.

For retained protocol registrations that use separate add/remove methods,
`objc.register` makes teardown deterministic:

```z
const registration = objc.register({
  add: contentController.addScriptMessageHandler(handler, "nativeBridge"),
  remove: contentController.removeScriptMessageHandlerForName("nativeBridge"),
});
```

The returned token retains the receiver, adapter, and Z controller, then invokes
the checked remove call exactly once during cleanup.

Objective-C references stored in a Z class are strong by default. This applies
to ordinary imported objects and `objc.Registration`, so a class returned from
a helper keeps its native graph alive after the helper's locals end. If a
native class also releases itself on a lifecycle event, disable that native
policy when Z is intended to remain the sole owner; AppKit windows use
`window.releasedWhenClosed = false` for this shape.

## Direct import versus `std/objc`

| Native shape | Preferred Z surface |
| --- | --- |
| Normal class, property, method, constant, nullable reference, or typed block | Direct header import |
| Lexically bounded temporary Objective-C work | `objc.pool` |
| Weak target plus selector | `objc.connect` |
| Protocol adapter stored by weak properties | `objc.bind` |
| Retained or stored `id<Protocol>` argument | `objc.adapt<P>` |
| Retained handler with paired add/remove calls | `objc.register` |

`std/objc` models runtime conventions missing from ordinary declarations. It is
not a generic message-send wrapper and should not sit between Z and APIs Clang
already describes safely.

```z
const result = try objc.pool((): WorkResult throws WorkError => {
  return try performObjectiveCWork();
});
```

`objc.pool` is synchronous and non-escaping. It lowers directly to
`@autoreleasepool`, drains before returning or propagating a typed error, and
rejects borrowed/view results or async closure bodies.

:::note[Cost model]
Ordinary calls lower to direct Objective-C message sends under ARC. Runtime
class narrowing adds one class-test message. `objc.pool` adds only the native
pool push/pop implied by `@autoreleasepool`; it allocates no Z wrapper.
`objc.connect`, `bind`, `adapt`, and `register` allocate or retain the explicit
adapter/lifetime state required to make the native convention safe.
:::

Runnable examples:
[native window](https://github.com/popaprozac/z/blob/main/examples/interop/objc/nswindow.zs),
[target/action](https://github.com/popaprozac/z/blob/main/examples/interop/objc/target-action.zs),
and [protocol conformance](https://github.com/popaprozac/z/blob/main/examples/interop/objc/protocol-conformance.zs).

Next: [C++ interop](/interop/cpp/).
