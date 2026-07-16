# Swift compatibility-header interop

This example builds a real Swift dylib and its generated Objective-C
compatibility header, compiles the Z source through the Objective-C ARC backend,
links both products, and runs the result:

```sh
./examples/swift-interop/run.sh
```

The Z source imports `ZSwiftExample-Swift.h` directly and uses the Swift class,
initializer, method, and writable property with ordinary Z syntax. The runner
performs the Swift build and native link explicitly because Z package manifests
and external-library link plans are not implemented yet.

This compatibility tier exposes only Swift declarations representable to
Objective-C. Native Swift module and Swift Package import remains a separate
future tier.
