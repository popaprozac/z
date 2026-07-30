struct Item {
  value: i32;
  fallback: Option<i32>;
}

struct Envelope {
  item?: Item;
}

function main(): i32 {
  const presentEnvelope = Envelope({
    item: Item({
      value: 42,
      fallback: Option<i32>.some(7),
    }),
  });
  const present = presentEnvelope.item;
  const selected = present?.value;
  const flattened = present?.fallback;
  const absentEnvelope = Envelope();
  const absent = absentEnvelope.item;
  const missing = absent?.value;
  const selectedValue = match (selected) {
    some(value) => value;
    none => 0;
  };
  const flattenedValue = match (flattened) {
    some(value) => value;
    none => 0;
  };
  const missingValue = match (missing) {
    some(value) => value;
    none => 0;
  };
  return selectedValue + flattenedValue + missingValue - 49;
}
