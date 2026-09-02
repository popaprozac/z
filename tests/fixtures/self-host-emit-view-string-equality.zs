function contains(
  in values: readonly Array<String>,
  in expected: String
): boolean {
  let index: usize = 0;
  while (index < values.length) {
    if (values[index] == expected) return true;
    index = index + 1;
  }
  return false;
}

function main(): i32 {
  let values = Array<String>("notes.count", "health.status");
  const frozen = values.freeze();
  return contains(in frozen, "health.status") ? 0 : 1;
}
