#!/bin/sh
set -eu

example_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$example_root/../../../.." && pwd)

exec bun "$project_root/compiler/src/cli.ts" run "$example_root"
