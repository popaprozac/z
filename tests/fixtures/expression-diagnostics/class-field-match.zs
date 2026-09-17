class Holder { value: i32; }
function main(): i32 {
  const option = Option<i32>.some(42);
  const holder = new Holder({ value: match (option) { some(value) => value; none => 0; } });
  return holder.value;
}
