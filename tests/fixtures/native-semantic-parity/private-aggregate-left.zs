import console from "std/console";

struct Hidden {
  value: i32;
  label: String;
  deinit { console.log(`left ${this.value}`); }
}

export struct LeftHolder {
  rows: Array<Array<Hidden>>;
}

export function createLeft(): LeftHolder {
  let row = Array<Hidden>();
  row.push(Hidden({ value: 42, label: "left" }));
  let rows = Array<Array<Hidden>>();
  rows.push(move row);
  return LeftHolder({ rows });
}
