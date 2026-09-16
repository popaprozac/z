readonly class Item { value: i32; }
enum Selection { item Item, empty, }
function read(in item: Item): i32 { return item.value; }
function readOption(in value: Option<Item>): i32 {
  return match (in value) { some(item) => read(in item); none => 0; };
}
function readSelection(in value: Selection): i32 {
  match (in value) { item(item) => return read(in item); empty => return 0; }
}
function main(): i32 {
  const item = new Item({ value: 42 });
  const option = Option.some(item);
  const selection = Selection.item(item);
  if (readOption(in option) != 42 || readSelection(in selection) != 42) return 1;
  return 0;
}
