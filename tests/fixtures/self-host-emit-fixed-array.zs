struct Coordinates {
  values: i32[3];
}

function fixedTotal(in values: i32[3]): i32 {
  return values[0] + values[1] + values[2];
}

function sliceTotal(values: Slice<i32>): i32 {
  return values[0] + values[1] + values[2];
}

function main(): i32 {
  const values = [20, 21, 22];
  if (values.length != 3) return 1;
  if (values[0] != 20 || values[2] != 22) return 2;
  if (fixedTotal(in values) != 63) return 3;
  if (sliceTotal(values) != 63) return 4;

  const [first, _, third] = values;
  if (first != 20 || third != 22) return 5;

  const [head, ...remaining] = view values;
  if (head != 20) return 6;
  if (remaining.length != 2) return 7;
  if (remaining[0] != 21 || remaining[1] != 22) return 8;

  const copied = copy values;
  if (copied[1] != 21) return 9;

  let mutableValues = [1, 2, 3];
  mutableValues[1] = 20;
  if (mutableValues[0] + mutableValues[1] + mutableValues[2] != 24) return 10;

  const coordinates = Coordinates({ values: [4, 8, 12] });
  if (coordinates.values[2] != 12) return 11;

  return 0;
}
