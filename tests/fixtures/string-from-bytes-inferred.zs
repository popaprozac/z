function main(): i32 {
  const bytes = Array<u8>(0, 255);
  return match (attempt String.fromBytes(bytes)) {
    success(_) => 1;
    failure(error) => error.byteOffset == 1 ? 0 : 2;
  };
}
