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

## ARC identity remains explicit

Imported Objective-C objects behave as shared reference identities. Assigning
or storing one applies the imported ownership convention and generated ARC
retains/releases. Nullable native references remain `T | null` and must be
narrowed before use.

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

```z
const controller = new TableController({});
const binding = objc.bind(tableView, {
  dataSource: controller,
  delegate: controller,
});
```

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

## Direct import versus `std/objc`

| Native shape | Preferred Z surface |
| --- | --- |
| Normal class, property, method, constant, nullable reference, or typed block | Direct header import |
| Weak target plus selector | `objc.connect` |
| Protocol adapter stored by weak properties | `objc.bind` |
| Retained handler with paired add/remove calls | `objc.register` |

`std/objc` models runtime conventions missing from ordinary declarations. It is
not a generic message-send wrapper and should not sit between Z and APIs Clang
already describes safely.

:::note[Cost model]
Ordinary calls lower to direct Objective-C message sends under ARC. Runtime
class narrowing adds one class-test message. `objc.connect`, `bind`, and
`register` allocate or retain the explicit adapter/lifetime state required to
make the native convention safe.
:::

Runnable examples:
[native window](https://github.com/popaprozac/z/blob/main/examples/interop/objc/nswindow.zs),
[target/action](https://github.com/popaprozac/z/blob/main/examples/interop/objc/target-action.zs),
and [protocol conformance](https://github.com/popaprozac/z/blob/main/examples/interop/objc/protocol-conformance.zs).

Next: [C++ interop](/interop/cpp/).
