import {
  Pair as ImportedPair,
  makePair,
  total,
} from "./model.zs";

function main(): i32 {
  const pair = makePair(20, 22);
  const updated = ImportedPair({ ...pair, second: 23 });
  return total(in updated) - 43;
}
