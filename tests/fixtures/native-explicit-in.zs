function byteCount(in value: String): usize {
  return value.byteLength;
}

function main(): i32 {
  const value = "answer";
  const inferred = byteCount(value);
  const explicit = byteCount(in value);
  return i32(inferred + explicit) - 12;
}
