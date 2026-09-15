// Bytes need not be text: embedded NUL and invalid UTF-8 remain ordinary data.
export c function byteCount(bytes: Slice<u8>): usize {
  return bytes.length;
}

export c function byteSum(bytes: Slice<u8>): u64 {
  let sum: u64 = 0;
  for (const byte of bytes) {
    sum = sum.wrappingAdd(u64(byte));
  }
  return sum;
}

// Ordinary Z calls pass the slice directly, without entering a C wrapper.
export c function combinedByteCount(left: Slice<u8>, right: Slice<u8>): usize {
  return byteCount(left) + byteCount(right);
}
