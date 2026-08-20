import { Envelope as Record } from "./model.zs";

function main(): i32 {
  let first = Record<i32>({ value: 40 });
  first.history.push(2);
  const second = Record<i32>({ value: 0, attempts: 2 });

  if (first.history.length != 1) return 1;
  if (second.history.length != 0) return 2;
  return first.value + first.history[0] + first.attempts
    + second.attempts - 45;
}
