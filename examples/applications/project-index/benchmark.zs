import { Map, Set } from "std/collections";

// Keep this public-API workload unchanged while collection storage evolves.
function main(): i32 {
  let revisions = Map<i32, i32>();
  let dirty = Set<i32>();

  let index = 0;
  while (index < 4000) {
    revisions.set(index, index + 1);
    dirty.add(index);
    index = index + 1;
  }

  let checksum = 0;
  let lookup = 0;
  while (lookup < 4000) {
    const found = revisions.get(lookup);
    const revision = match (in found) {
      some(revision) => revision;
      none => 0;
    };
    checksum = checksum + revision;
    lookup = lookup + 1;
  }

  let removed = 0;
  let candidate = 0;
  while (candidate < 4000) {
    if (candidate % 2 == 0) {
      const result = dirty.remove(candidate);
      match (result) {
        some(value) => removed = removed + value;
        none => return 1;
      }
    }
    candidate = candidate + 1;
  }

  if (revisions.length != 4000) return 2;
  if (dirty.length != 2000) return 3;
  if (checksum != 8002000) return 4;
  if (removed != 3998000) return 5;
  return 0;
}
