import { makeGrid, rowTotal } from "./values.zs";

function main(): i32 {
  const grid = makeGrid();
  const firstRow = grid[0];
  if (rowTotal(in firstRow) != 21) return 1;

  let total = 0;
  for (const row of grid) {
    total = total + rowTotal(in row);
  }
  if (total != 62) return 2;

  return 0;
}
