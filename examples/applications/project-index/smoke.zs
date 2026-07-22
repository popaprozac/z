import {
  IndexReport,
  ProjectIndex,
} from "./index.zs";

function verifyReport(report: IndexReport): i32 {
  if (report.record.contents != "draft") return 1;
  if (report.record.revision != 1) return 2;
  if (report.indexedFiles != 1) return 3;
  if (!report.dirty) return 4;
  return 0;
}

function main(): i32 {
  let index = ProjectIndex.empty();
  const path = "notes/readme.md";

  const firstRevision = index.upsert(path, "draft");
  const beforeMutation = index.report(path);
  const secondRevision = index.upsert(path, "revised draft");

  const snapshotStatus = match (beforeMutation) {
    some(report) => verifyReport(move report);
    none => 5;
  };
  if (snapshotStatus != 0) return snapshotStatus;
  if (firstRevision != 1 || secondRevision != 2) return 6;
  if (index.count() != 1 || !index.isDirty(path)) return 7;
  if (!index.markSaved(path) || index.isDirty(path)) return 8;

  const afterMutation = index.snapshot(path);
  return match (afterMutation) {
    some(record) => (if (record.contents == "revised draft" && record.revision == 2) {
      select 0;
    } else {
      select 9;
    });
    none => 10;
  };
}
