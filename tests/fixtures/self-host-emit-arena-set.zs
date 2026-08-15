import { Set } from "std/collections";
import { Hashable, Hasher } from "std/hash";
import { Arena } from "std/memory";

struct Coordinate {
  line: i32;
  column: i32;
}

readonly struct CoordinateKey implements Hashable {
  coordinate: view Coordinate;

  function equals(in other: CoordinateKey): boolean {
    const current = this.coordinate;
    const candidate = other.coordinate;
    return current.line == candidate.line
      && current.column == candidate.column;
  }

  function hash(inout hasher: Hasher): void {
    const current = this.coordinate;
    hasher.add(current.line);
    hasher.add(current.column);
  }
}

function main(): i32 {
  let arena = Arena();
  const first = arena.create(Coordinate({ line: 20, column: 22 }));
  let keys = Set<CoordinateKey>();
  keys.add(CoordinateKey({ coordinate: first }));
  const removed = keys.remove(CoordinateKey({ coordinate: first }));
  const result = match (in removed) {
    some(key) => {
      const coordinate = key.coordinate;
      select coordinate.line + coordinate.column;
    }
    none => 0;
  };
  const stored = arena.create(keys);
  return result - 42 + i32(stored.length);
}
