# Deployment-target availability

This project selects macOS 13 in `z.json` so header import, availability
checking, and native compilation use the same minimum deployment target.

Run the manifest-selected executable through the repository Stage-0 wrapper:

```sh
bun run z check examples/interop/c/deployment-target
bun run z run examples/interop/c/deployment-target
```

With the native `z` executable on `PATH`, the same project can be selected from
this directory with `z check .` and `z run .`.

Changing `target.minimumVersion` changes both Z diagnostics and the deployment
flag passed to the native compiler. Stage 0 currently accepts only the host
platform; cross-compilation and runtime availability guards remain future
layers.
