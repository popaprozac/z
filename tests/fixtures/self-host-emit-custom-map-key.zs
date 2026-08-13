import { Map } from "std/collections";
import { Hashable, Hasher } from "std/hash";

readonly struct ModuleKey implements Hashable {
  package: String;
  path: String;

  function equals(in other: ModuleKey): boolean {
    return this.package == other.package && this.path == other.path;
  }

  function hash(inout hasher: Hasher): void {
    hasher.add(this.package);
    hasher.add(this.path);
  }
}

function main(): i32 {
  let ordinals = Map<i32, i32>();
  ordinals.set(20, 22);
  if (!ordinals.has(20)) return 5;

  let modules = Map<ModuleKey, i32>();
  modules.set(ModuleKey({ package: "std", path: "collections" }), 20);
  modules.set(ModuleKey({ package: "std", path: "collections" }), 42);

  const key = ModuleKey({ package: "std", path: "collections" });
  if (!modules.has(key)) return 1;
  const found = modules.get(key);
  const value = match (in found) {
    some(revision) => revision;
    none => 0;
  };
  if (value != 42) return 2;
  if (!modules.delete(key)) return 3;
  if (modules.delete(key)) return 4;
  const ordinalFound = ordinals.get(20);
  const ordinal = match (in ordinalFound) {
    some(value) => value;
    none => 0;
  };
  return ordinal - 22;
}
