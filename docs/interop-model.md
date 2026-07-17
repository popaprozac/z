# Interop Model

The language's primary interop syntax is intentionally ordinary:

```z
import sqlite from "sqlite3.h";
```

The module name provides a Z namespace while generated native calls remain
direct:

```z
sqlite.sqlite3_libversion();
```

The bootstrap compiler treats an imported module member as a native symbol and
lets Clang validate the generated call. The production importer must instead
parse headers with Clang and represent declarations, layouts, macros that can be
modeled safely, overloads, calling conventions, availability, and documentation
in a cached foreign module.

Headers do not reliably encode ownership or asynchronous callback contracts.
Packages can therefore ship Z API notes without modifying upstream headers.
Raw declarations remain accessible, while annotated declarations gain safe Z
overloads.

The first callback tier requires a call-only lifetime:

```json
{
  "functions": {
    "z_apply_i32": {
      "parameters": {
        "2": {
          "callback": {
            "lifetime": "call"
          }
        }
      }
    }
  }
}
```

Clang supplies the function pointer's exact parameter and result ABI. The API
note supplies the fact the header omits: C does not retain the callback after
the call returns. Z can therefore pass a named function or explicitly typed
non-capturing closure directly with no allocation or wrapper. A callback
without this contract remains unsupported. Z-owned capturing closures now have
ARC environments and deterministic release, but a context-free C function
pointer still has nowhere to carry that environment. Passing one therefore
waits for API-note-described context-pointer adapters. Escaping callbacks also
need retention and unregistration rules; callback-to-async additionally
requires completion cardinality, threading, cancellation, and executor
metadata.
