struct Label {
  text: String;
  priority: i32;
}

enum RecordState {
  active String,
  archived,
}

struct FileRecord {
  path: String;
  label: Label;
  tags: Array<String>;
  state: RecordState;
  discarded: String;
  revision: i32;
}

function main(): i32 {
  const original = FileRecord({
    path: "notes/readme.md",
    label: Label({ text: "draft", priority: 20 }),
    tags: Array<String>("docs", "draft"),
    state: RecordState.active("editing"),
    discarded: "temporary",
    revision: 22,
  });

  const { path: copiedPath, label: copiedLabel } = copy original;
  const copiedTags = copy original.tags;
  const { path: movedPath, revision: movedRevision } = move original;

  if (copiedPath != movedPath) return 1;
  if (copiedLabel.text != "draft") return 2;
  if (copiedTags[1] != "draft") return 3;
  return copiedLabel.priority + movedRevision - 42;
}
