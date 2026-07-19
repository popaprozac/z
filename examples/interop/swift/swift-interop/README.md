# Swift compatibility-header interop

This example's `z.json` declares a Swift target. The ordinary Z CLI builds its
dylib and generated Objective-C compatibility header, compiles the Z source
through the Objective-C ARC backend, links both products, and runs the result:

```sh
bun run z run examples/interop/swift/swift-interop/main.z
```

The Z source imports `ZSwiftExample-Swift.h` directly and uses the Swift class,
initializer, method, and writable property with ordinary Z syntax. Compiler and
language-server analysis share the manifest build graph and generated include
directory. `run.sh` remains only as a convenience wrapper for the command above.

The manifest also carries `Foundation` into the final native link plan. Build
products live under this example's ignored `.z-cache` directory and are rebuilt
when `Counter.swift` or `z.json` changes.

This compatibility tier exposes only Swift declarations representable to
Objective-C. Native Swift module and Swift Package import remains a separate
future tier.
