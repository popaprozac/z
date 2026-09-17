class Holder { value: i32; }
function missing(in value: Option<i32>): boolean {
  return match (in value) { some(_) => false; none => true; };
}
function empty(): Option<i32> { return Option.none; }
function main(): i32 {
  const source = Option<i32>.some(42);
  const chosen = match (source) { some(value) => value; none => 0; };
  const holder = new Holder({ value: chosen });
  const contextual: Option<i32> = Option.none;
  const explicit = Option<i32>.none;
  const returned = empty();
  if (!missing(in contextual) || !missing(in explicit) || !missing(in returned)) return 1;
  return holder.value == 42 ? 0 : 2;
}
