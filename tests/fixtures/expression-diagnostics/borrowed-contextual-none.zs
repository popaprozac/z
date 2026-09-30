function main(): i32 {
  const missing = (in value: Option<i32>): boolean => {
    return match (in value) { some(_) => false; none => true; };
  };
  if (missing(Option.none)) return 0;
  return 1;
}
