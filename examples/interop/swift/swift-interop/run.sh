#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
example_root="$project_root/examples/interop/swift/swift-interop"

exec bun "$project_root/compiler/src/cli.ts" run "$example_root/main.zs"
