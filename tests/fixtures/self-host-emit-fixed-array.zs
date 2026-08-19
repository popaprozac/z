struct Coordinates {
  values: i32[3];
}

struct Grid {
  rows: i32[2][2];
}

function makeValues(): i32[3] {
  return [20, 21, 22];
}

function fixedTotal(in values: i32[3]): i32 {
  return values[0] + values[1] + values[2];
}

function sliceTotal(values: Slice<i32>): i32 {
  return values[0] + values[1] + values[2];
}

function main(): i32 {
  const values = makeValues();
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

  let iteratedTotal = 0;
  for (const value of values) {
    iteratedTotal = iteratedTotal + value;
  }
  if (iteratedTotal != 63) return 12;

  const grid = Grid({ rows: [[1, 2], [3, 4]] });
  if (grid.rows[1][0] != 3) return 13;

  const copiedRows = copy grid.rows;
  if (copiedRows[0][1] != 2) return 14;

  let gridTotal = 0;
  for (const row of grid.rows) {
    for (const value of row) {
      gridTotal = gridTotal + value;
    }
  }
  if (gridTotal != 10) return 15;

  return 0;
}
