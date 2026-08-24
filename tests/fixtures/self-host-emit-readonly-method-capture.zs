type Reader = () => i32;

readonly class Snapshot {
  value: i32;

  function reader(): Reader {
    return createReader(this);
  }
}

function createReader(snapshot: Snapshot): Reader {
  return move (): i32 => snapshot.value;
}

function main(): i32 {
  const snapshot = new Snapshot({ value: 42 });
  const reader = snapshot.reader();
  return reader() - snapshot.value;
}
