struct Envelope<T> {
  value: T;
  attempts: i32 = 1;
  history: Array<T> = Array<T>();
}

function main(): i32 {
  let first = Envelope<i32>({ value: 40 });
  first.history.push(2);
  const second = Envelope<i32>({ value: 0, attempts: 2 });

  if (first.history.length != 1) return 1;
  if (second.history.length != 0) return 2;
  return first.value + first.history[0] + first.attempts
    + second.attempts - 45;
}
