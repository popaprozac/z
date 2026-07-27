enum Mode {
  idle,
  active,
  stopped,
}

struct Snapshot {
  mode: Mode;
  count: i32;
}

function score(mode: Mode): i32 {
  if (mode == Mode.active) return 40;
  if (mode == Mode.stopped) return -1;
  return 0;
}

function main(): i32 {
  const snapshot: Snapshot = Snapshot({
    mode: Mode.active,
    count: 2,
  });
  return score(snapshot.mode) + snapshot.count;
}
