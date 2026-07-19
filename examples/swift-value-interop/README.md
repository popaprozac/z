# Swift owned-value interop

This probe imports a generated Swift C++ compatibility header directly from Z:

```sh
bun run z run examples/swift-value-interop/main.z
```

`OwnedCounter` is a Swift-native struct containing a reference to a Swift class.
The Z program constructs it through the Swift-generated static `init` method,
copies it, stores and copies it inside a Z struct, and round-trips it through
Swift. It then calls generated const and mutable instance methods directly from
Z. The generated C++ value wrapper performs copy construction and deterministic
destruction. The shared Swift lifetime probe is released exactly once after
every value wrapper leaves scope.

Expected output:

```text
created 40
first=40, copied=40, changed=42
released 40
```

This is intentionally a narrow ownership probe. Generated Swift C++ wrappers are
currently copyable but delete C++ move assignment. Z imports their generated
static and instance methods; Swift property sugar, generic types, and
`swift::String` remain later slices.
