export function makeGrid(): i32[2][2] {
  return [[10, 11], [20, 21]];
}

export function rowTotal(in row: i32[2]): i32 {
  return row[0] + row[1];
}
