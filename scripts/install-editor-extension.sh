#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
extension_source="$project_root/editors/vscode"
installed=0

install_into() {
  extension_root=$1
  if [ -d "$extension_root" ]; then
    ln -sfn "$extension_source" "$extension_root/z-lang.z-lang-0.0.1"
    printf 'Installed Z language support in %s\n' "$extension_root"
    installed=1
  fi
}

install_into "$HOME/.vscode/extensions"
install_into "$HOME/.cursor/extensions"

if [ "$installed" -eq 0 ]; then
  printf '%s\n' 'No VS Code or Cursor extensions directory was found.' >&2
  exit 1
fi

printf '%s\n' 'Reload the editor window, then open a .z file. Bun must be available on PATH.'
