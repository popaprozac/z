struct Holder {
  value: i32;

  function missing(in value: Option<i32>): boolean {
    return match (in value) { some(_) => false; none => true; };
  }
}

function missing(in value: Option<i32>): boolean {
  return match (in value) { some(_) => false; none => true; };
}

function main(): i32 {
  const holder = Holder({ value: 1 });
  if (!missing(Option.none)) return 1;
  if (!holder.missing(Option.none)) return 2;
  return 0;
}
