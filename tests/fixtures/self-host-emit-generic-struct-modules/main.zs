import {
  Pair as ImportedPair,
  makePair,
  total,
} from "./model.zs";

function main(): i32 {
  const pair = ImportedPair.create(20, 22);
  const made = makePair(10, 11);
  let updated = ImportedPair({ ...pair, second: 21 });
  updated.replaceSecond(23);
  return total(in updated) + total(in made) - 64;
}
