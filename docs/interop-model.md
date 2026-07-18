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

## Cost model

Z's target is **no interop tax beyond the semantics requested at the
boundary**, not a claim that every bridge operation is free:

| Boundary shape | Intended/generated cost |
| --- | --- |
| C scalar or function call | Native ABI call; no wrapper or allocation |
| C record by value or scoped borrow | Native layout and calling convention; no wrapper allocation |
| Objective-C method or property | Ordinary `objc_msgSend`-family dispatch under Clang ARC |
| Plain C++/Swift-C++ value | Native construction, copy, and destruction rules |
| Non-capturing call-only callback | Function pointer or small adapter indirection; no environment allocation |
| Escaping capturing closure / Objective-C block | Owned closure environment plus a native lifetime adapter, retains/releases, and indirect invocation |
| `String` / `NSString` ownership bridge | Deliberate allocation and byte copy so neither runtime borrows unstable storage |
| Z ARC class reference | Retain/release traffic; the bootstrap runtime is non-atomic and not yet optimized |

Imported nullable references use the same one-pointer representation as their
native ABI. A Z null check is an ordinary pointer comparison and narrows the
reference statically; the first reference specialization uses `T | null` in
source and does not allocate a tagged `Option` wrapper. The language model treats
this as niche-backed optionality. `Option.fromNullable` exposes that same value
through `some`/`none` matching; `Option<ObjC reference>` remains one pointer,
with `nil` as `none`, and requires neither a wrapper allocation nor a separate
tag. General `Option<T>` keeps its tag-plus-payload representation when no safe
niche is known.

The bootstrap `z run` path currently asks Clang for a debuggable native build
without an optimization flag. Its runtime measurements therefore validate
behavior, not Z's eventual optimized performance ceiling. Release profiles,
retain/release optimization, escape analysis, and generated-code benchmarking
remain compiler work.

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
without this contract remains unsupported.

Capturing closures use a paired context contract:

```json
{
  "functions": {
    "applyWithContext": {
      "parameters": {
        "2": {
          "callback": {
            "lifetime": "call",
            "context": {
              "parameter": 1,
              "callbackParameter": 1
            }
          }
        }
      }
    }
  }
}
```

All indexes are zero-based. `parameter` identifies the C function's hidden
`void *` parameter; `callbackParameter` identifies that context argument inside
the callback signature. The generated trampoline casts the native context back
to the borrowed Z function value and invokes its `call` entry with the owned
environment. Since the lifetime is call-only, the caller keeps the ARC owner
alive and no native retain/release protocol is invented.

The first escaping tier requires the C API to accept a destroy callback:

```json
{
  "functions": {
    "retainOperation": {
      "parameters": {
        "0": {
          "callback": {
            "lifetime": "escape",
            "thread": "caller",
            "context": {
              "parameter": 1,
              "callbackParameter": 1
            },
            "release": {
              "parameter": 2,
              "callbackParameter": 0
            }
          }
        }
      }
    }
  }
}
```

Z retains the function value in a stable heap box and passes generated callback
and release thunks. The local function value can then leave scope while C owns
the box. C must take ownership unconditionally, invoke both callbacks only on
the thread that registered them, call release exactly once after the final
invocation, and never invoke the callback afterward. Those requirements are a
trusted foreign contract, just like pointer ownership API notes.

Cross-thread callbacks wait for atomic ARC and sendability rules. Conditional
ownership transfer and APIs that require a separate unregister call need an
owned registration-token model. Callback-to-async additionally requires
completion cardinality, cancellation, and executor metadata.
