import { Map } from "std/collections";

struct FileRecord {
  path: String;
  revision: i32;
}

function main(): i32 {
  const original = FileRecord({ path: "notes/readme.md", revision: 21 });
  const { path: copiedPath, revision: copiedRevision } = copy original;
  const { path: movedPath, revision: movedRevision } = move original;

  let revisions = Map<String, i32>();
  revisions.set("first.zs", copiedRevision);
  revisions.set("second.zs", movedRevision);

  let observed = 0;
  for (const { key, value } of revisions) {
    if (key.isEmpty) return 2;
    observed = observed + value;
  }

  if (copiedPath != movedPath) return 1;
  return observed - 42;
}
