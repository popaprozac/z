function add(a: i32, b: i32): i32 {
  return a + b;
}

function describe(
  answer: i32,
  byte: u8,
  size: usize,
  ready: boolean
): String {
  return `answer=${answer},byte=${byte},size=${size},ready=${ready}`;
}

function arraySum(): i32 {
  let values = Array<i32>();
  values.push(20);
  values.push(22);
  if (values.length != 2) return 0;
  if (values[0] != 20 || values[1] != 22) return 0;
  let total: i32 = 0;
  for (const value of values) {
    total = total + value;
  }
  return total;
}

function main(): i32 {
  const answer: i32 = add(20, 22);
  const message = describe(answer, 7, 9, true);
  return answer == 42
    && arraySum() == 42
    && message == "answer=42,byte=7,size=9,ready=true"
    ? answer
    : 0;
}
