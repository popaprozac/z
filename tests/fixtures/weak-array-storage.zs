import { ObservedItem } from "./weak-array-item.zs";

function observe(inout values: Array<Weak<ObservedItem>>): void {
  const item = new ObservedItem({ value: 42 });
  values.push(weak item);
  const held = match (attempt values[0].upgrade()) { success(value) => value; failure(_) => return; };
  if (held.value != 42) return;
}

function main(): i32 {
  let values = Array<Weak<ObservedItem>>();
  observe(inout values);
  for (const value of values) {
    match (attempt value.upgrade()) { success(_) => return 1; failure(_) => {} }
  }
  return 0;
}
