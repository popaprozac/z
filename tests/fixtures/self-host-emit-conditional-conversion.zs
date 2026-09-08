function selectDelay(ready: boolean): u64 {
  return u64(ready ? 250 : 8000);
}

function selectNested(first: boolean, second: boolean): i64 {
  return i64(first ? 20 : second ? 21 : 22);
}

function selectWide(ready: boolean, high: u64, low: u64): u64 {
  return u64(ready ? high : low);
}

function selectFloat(ready: boolean, high: f32, low: f32): f64 {
  return f64(ready ? high : low);
}

function selectText(ready: boolean): boolean {
  const text = ready ? "ready" : "waiting";
  return text == "ready";
}

function main(): i32 {
  if (selectDelay(true) != 250 || selectDelay(false) != 8000) return 1;
  if (selectNested(true, true) != 20) return 2;
  if (selectNested(false, true) != 21 || selectNested(false, false) != 22) return 3;
  if (selectWide(true, 4294967296, 7) != 4294967296) return 4;
  if (selectWide(false, 4294967296, 7) != 7) return 5;
  if (selectFloat(true, 2.5, 1.25) != 2.5) return 6;
  if (selectFloat(false, 2.5, 1.25) != 1.25) return 7;
  if (!selectText(true) || selectText(false)) return 8;
  return 0;
}
