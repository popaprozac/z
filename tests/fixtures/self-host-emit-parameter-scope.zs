struct Record {
  value: i32;
}

struct Store {
  records: Array<Record>;
}

function inspectStore(in store: Store): usize {
  const records = view store.records;
  return records.length;
}

function takeLength(in values: Array<Record>): usize {
  return values.length;
}

function inspectRecords(in records: Array<Record>): usize {
  return takeLength(in records);
}

function main(): i32 {
  const records = Array<Record>(Record({ value: 42 }));
  const store = Store({
    records: Array<Record>(Record({ value: 22 })),
  });
  return i32(inspectStore(store) + inspectRecords(records)) - 2;
}
