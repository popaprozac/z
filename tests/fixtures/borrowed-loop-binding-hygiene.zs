class Item { text: String; }
struct Entry { label: String; item: Item; }

function main(): i32 {
  const strings = Array<String>("value");
  for (const namespace of strings) {
    if (namespace != "value") return 1;
  }
  const items = Array<Item>(new Item({ text: "item" }));
  for (const template of items) {
    if (template.text != "item") return 2;
  }
  const entries = Array<Entry>(Entry({ label: "label", item: new Item({ text: "entry" }) }));
  for (const entry of entries) {
    if (entry.label != "label" || entry.item.text != "entry") return 3;
  }
  return 0;
}
