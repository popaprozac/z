import console from "std/console";

struct Hidden {
  label: String;
  value: u16;
  extra: Array<String>;
  deinit { console.log(`right ${this.value}`); }
}

export struct RightHolder {
  items: Array<Hidden>;
}

export function createRight(): RightHolder {
  let items = Array<Hidden>();
  items.push(Hidden({ label: "right", value: 300, extra: Array<String>("nested") }));
  return RightHolder({ items });
}
