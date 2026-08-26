---
title: Header imports
description: Import C, Objective-C, and supported C++ declarations directly from the real native header.
sidebar:
  order: 2
---

The first interop tier is deliberately small: import the header and use its
declarations as Z values and types.

```z
import stdio from "stdio.h";

function main(): i32 {
  stdio.printf("hello from Z\n");
  return 0;
}
```

Clang—not a handwritten wrapper—is the ABI authority. It supplies native
signatures, layouts, calling conventions, namespaces, supported constants,
availability, and source locations.

## Namespace and selective imports

A default import keeps native declarations grouped:

```z
import sqlite from "sqlite3.h";

const version = sqlite.sqlite3_libversion();
```

Selective imports expose only chosen symbols and support aliases:

```z
import {
  sqlite3_open,
  sqlite3_close as closeDatabase
} from "sqlite3.h";
```

Both forms refer to the same header-derived declarations. The import shape does
not introduce a wrapper function, runtime namespace object, or dispatch table.

## Configure where implementation comes from

Importing a header describes the API. Linking selects the native implementation:

```json
{
  "target": {
    "name": "database-probe",
    "entry": "main.zs",
    "includeDirectories": ["vendor/include"],
    "link": {
      "directories": ["vendor/lib"],
      "libraries": ["sqlite3"]
    }
  }
}
```

On Apple targets, use checked framework names rather than raw linker flags:

```json
{
  "target": {
    "name": "window",
    "entry": "main.zs",
    "platform": "macos",
    "minimumVersion": "14.0",
    "link": {
      "frameworks": ["AppKit"]
    }
  }
}
```

The minimum deployment version is applied consistently to header import,
availability checking, generated source, and native compilation. Calling a
newer API produces a Z-site diagnostic rather than a late generated-file error.

## Native values remain typed

Imported records preserve their nominal identity and layout. Imported integer
enums preserve their native type, including flag combinations:

```z
import AppKit from "AppKit/AppKit.h";

const style = AppKit.NSWindowStyleMaskTitled
  | AppKit.NSWindowStyleMaskClosable
  | AppKit.NSWindowStyleMaskResizable;
```

Native nullability remains explicit as `T | null`. Narrow before use, or lift a
nullable boundary into Z's domain-oriented `Option<T>`:

```z
const selected = Option.fromNullable(app.keyWindow);

match (selected) {
  some(window) => window.center();
  none => console.log("no key window");
}
```

Lifting a nullable pointer or Objective-C reference into `Option` does not
invent ARC for the enum itself. It stores the same payload representation and
applies whatever ownership the contained native identity already requires.

## Objective-C feels like Z

Properties and messages use ordinary member syntax:

```z
import AppKit from "AppKit/AppKit.h";

const app = AppKit.NSApplication.sharedApplication;
app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

const frame = AppKit.NSMakeRect(0.0, 0.0, 800.0, 600.0);
const style = AppKit.NSWindowStyleMaskTitled
  | AppKit.NSWindowStyleMaskClosable
  | AppKit.NSWindowStyleMaskResizable;
const window = AppKit.NSWindow.alloc().initWithContentRect(
  frame,
  styleMask: style,
  backing: AppKit.NSBackingStoreBuffered,
  defer: false
);

window.title = "Native Z";
window.center();
window.makeKeyAndOrderFront(null);
app.activate();
app.run();
```

ARC retains/releases, nullable properties, selector lookup, inheritance, and
availability remain compiler-visible. Z syntax does not turn a message send
into a JavaScript-style dynamic property access.

## Supported C++ stays namespaced

C++ namespace identity is retained under `zcpp`:

```z
import native from "geometry.hpp";

const point = native.zcpp.Point({ x: 20, y: 22 });
const total = point.sum();
```

The current tier covers useful value, method, namespace, RAII, and move-only
shapes. Templates, exception translation, arbitrary references, and complete
standard-library-scale import remain active expansion areas.

## Know when a header is not enough

A C header can prove a function's ABI, but often cannot say:

- who owns a returned pointer or record;
- which function destroys it;
- whether a status code means failure;
- how callback context and release functions pair;
- which thread may invoke a callback;
- whether one pointer/length pair is a borrowed slice.

Z does not guess those facts. Add an adjacent `.zd` contract when they are
required for safe, ergonomic use.

:::note[Cost model]
A supported imported call lowers to the native call or message send. Namespace
imports, selective imports, type checking, availability checking, and `.zd`
lookup are compile-time structure—not runtime wrappers.
:::

Runnable examples:
[AppKit window](https://github.com/popaprozac/z/blob/main/examples/interop/objc/nswindow.zs),
[curl](https://github.com/popaprozac/z/tree/main/examples/applications/z-curl),
[raylib](https://github.com/popaprozac/z/tree/main/examples/applications/z-raylib),
and [SDL3](https://github.com/popaprozac/z/tree/main/examples/applications/z-sdl3).

Next: [Z declaration contracts](/interop/z-declaration-contracts/).
