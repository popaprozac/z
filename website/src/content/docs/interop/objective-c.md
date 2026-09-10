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

## ARC identity remains explicit

Imported Objective-C objects behave as shared reference identities. Assigning
or storing one applies the imported ownership convention and generated ARC
retains/releases. Nullable native references remain `T | null` and must be
narrowed before use.

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

## Native subclasses (experimental Stage 0 tier)

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
This tier is field-free and synchronous: Z-stored fields, `deinit`, `Weak`,
fallible constructors, object-returning overrides, and async composition remain
future work. Ordinary Z-to-Z inheritance is not supported. Use the TypeScript
Stage 0 compiler for execution. The native frontend now parses these declarations
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
owned captures. Synchronous borrowed-callback forwarding still needs a complete
escape proof in both frontends; direct conversion checks alone are not enough.
Native deprecation warnings remain pending.
Execution still reports `Z0814` pending complete ownership/availability composition
and native emission. This typed-body checkpoint does not enable native
execution or stateful subclasses.

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
