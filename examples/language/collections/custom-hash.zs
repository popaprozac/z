import { Map, Set } from "std/collections";
import { Hashable, Hasher } from "std/hash";

readonly struct ProjectKey implements Hashable {
  workspace: String;
  path: String;

  function equals(in other: ProjectKey): boolean {
    return this.workspace == other.workspace && this.path == other.path;
  }

  function hash(inout hasher: Hasher): void {
    hasher.add(this.workspace);
    hasher.add(this.path);
  }
}

function main(): i32 {
  let revisions = Map<ProjectKey, i32>();
  revisions.set(ProjectKey({ workspace: "z", path: "src/main.zs" }), 41);
  revisions.set(ProjectKey({ workspace: "z", path: "src/main.zs" }), 42);

  const lookup = ProjectKey({ workspace: "z", path: "src/main.zs" });
  const found = revisions.get(lookup);
  const revision = match (in found) {
    some(value) => value;
    none => 0;
  };

  let dirty = Set<ProjectKey>();
  if (!dirty.add(ProjectKey({ workspace: "z", path: "src/main.zs" }))) return 2;
  if (dirty.add(ProjectKey({ workspace: "z", path: "src/main.zs" }))) return 3;
  if (!dirty.delete(lookup)) return 1;
  return revision - 42;
}
