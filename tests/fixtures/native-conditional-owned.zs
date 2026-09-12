import { TextBuffer } from "std/text";

class Audit { destroyed: i32; }
class Item {
  audit: Audit;
  value: i32;
  deinit {
    const audit = this.audit;
    audit.destroyed = audit.destroyed + 1;
  }
}

function verifyShared(prefer: boolean, audit: Audit): i32 {
  const left = new Item({ audit, value: 20 });
  const right = new Item({ audit, value: 22 });
  const selected = prefer ? left : right;
  // Selection retains shared identity; both original handles remain usable.
  if (left.value + right.value != 42) return 4;
  if (selected.value != (prefer ? 20 : 22)) return 5;
  return 0;
}

function allocated(value: i32): String {
  let text = TextBuffer();
  text.append(`value ${value}`);
  return text.finish();
}

function choose(prefer: boolean): String {
  const owned = allocated(42);
  return prefer ? owned : "fallback";
}

function verify(prefer: boolean): i32 {
  const source = allocated(1);
  const selected = prefer ? source : "fallback";
  if (selected != (prefer ? "value 1" : "fallback")) return 1;
  const returned = choose(prefer);
  if (returned != (prefer ? "value 42" : "fallback")) return 2;
  const left = allocated(2);
  const right = allocated(3);
  const selectedOwner = prefer ? left : right;
  if (selectedOwner != (prefer ? "value 2" : "value 3")) return 3;
  return 0;
}

function main(): i32 {
  const first = verify(true);
  if (first != 0) return first;
  const second = verify(false);
  if (second != 0) return second;
  const audit = new Audit({ destroyed: 0 });
  const sharedFirst = verifyShared(true, audit);
  if (sharedFirst != 0 || audit.destroyed != 2) return 6;
  const sharedSecond = verifyShared(false, audit);
  if (sharedSecond != 0 || audit.destroyed != 4) return 7;
  return 0;
}
