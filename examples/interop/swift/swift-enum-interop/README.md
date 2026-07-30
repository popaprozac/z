# Swift enum interop

This probe constructs a Swift-native associated-value enum directly from Z
through Swift's generated C++ compatibility header:

```sh
bun run z run examples/interop/swift/swift-enum-interop
```

The Z source calls the generated Swift case factories with ordinary namespaced
call syntax:

```z
const ready = Swift.LoadState.ready(42);
const idle = Swift.LoadState.idle();
```

No Swift helper function or handwritten C/C++ shim is involved. `LoadState` is
an owned Swift value in Z: copying it invokes the generated value wrapper's copy
semantics, and leaving scope invokes its destructor.

Expected output:

```text
ready=42, idle=-1, copy=42
```

This is a deliberately narrow direct-Swift vertical slice. Swift 6.2's generated
C++ interface still marks noncopyable (`~Copyable`) values and Swift `async`
functions unavailable to C++, so those cannot yet cross this boundary without a
Swift-authored compatibility layer.
