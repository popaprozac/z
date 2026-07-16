#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
extension_source="$project_root/editors/vscode"
extension_version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$extension_source/package.json" | head -n 1)
extension_directory="z-lang.z-lang-$extension_version"
installed=0

install_into() {
  extension_root=$1
  if [ -d "$extension_root" ]; then
    extension_path="$extension_root/$extension_directory"
    ln -sfn "$extension_source" "$extension_path"
    for old_path in "$extension_root"/z-lang.z-lang-*; do
      if [ -L "$old_path" ] && [ "$old_path" != "$extension_path" ]; then
        unlink "$old_path"
      fi
    done
    bun -e '
      const root = process.argv[1];
      const version = process.argv[2];
      const directory = process.argv[3];
      const obsoleteFile = `${root}/.obsolete`;
      if (await Bun.file(obsoleteFile).exists()) {
        const obsolete = JSON.parse(await Bun.file(obsoleteFile).text());
        for (const name of Object.keys(obsolete)) {
          if (name.startsWith("z-lang.z-lang-")) delete obsolete[name];
        }
        await Bun.write(obsoleteFile, JSON.stringify(obsolete));
      }
      const indexFile = `${root}/extensions.json`;
      if (await Bun.file(indexFile).exists()) {
        const entries = JSON.parse(await Bun.file(indexFile).text());
        const previous = entries.find((item) => item.identifier?.id === "z-lang.z-lang");
        const location = `${root}/${directory}`;
        const current = {
          ...previous,
          identifier: { ...(previous?.identifier ?? {}), id: "z-lang.z-lang" },
          version,
          location: { $mid: 1, path: location, scheme: "file" },
          relativeLocation: directory,
        };
        await Bun.write(
          indexFile,
          JSON.stringify([...entries.filter((item) => item.identifier?.id !== "z-lang.z-lang"), current]),
        );
      }
    ' "$extension_root" "$extension_version" "$extension_directory"
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
