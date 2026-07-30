struct Label {
  value: String;
}

struct Pair {
  first: i32;
  second: i32;
}

function main(): i32 {
  const baseline = Pair({ first: 20, second: 22 });
  const plain = Pair({ ...baseline, first: 21 });
  const copied = Pair({ copy ...baseline, second: 23 });
  const copySource = Label({ value: "ready" });
  const copiedLabel = Label({ copy ...copySource });
  const label = Label({ value: "ready" });
  const moved = Label({ move ...label });
  return plain.first
    + copied.second
    + i32(copiedLabel.value.byteLength)
    + i32(moved.value.byteLength)
    - 54;
}
