#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
example_root="$project_root/examples/swift-interop"
build_root="$project_root/.z-cache/swift-interop"

mkdir -p "$build_root"

xcrun swiftc \
  -emit-library \
  -emit-module \
  -module-name ZSwiftExample \
  -emit-objc-header-path "$build_root/ZSwiftExample-Swift.h" \
  "$example_root/Counter.swift" \
  -o "$build_root/libZSwiftExample.dylib"

cp "$example_root/main.z" "$build_root/main.z"
bun "$project_root/compiler/src/cli.ts" emit "$build_root/main.z" > "$build_root/main.m"

xcrun clang \
  -x objective-c \
  -fobjc-arc \
  -Wall -Wextra -Werror \
  -I "$build_root" \
  -c "$build_root/main.m" \
  -o "$build_root/main.o"

xcrun clang \
  "$build_root/main.o" \
  "$build_root/libZSwiftExample.dylib" \
  -framework Foundation \
  -o "$build_root/swift-interop"

exec "$build_root/swift-interop"
