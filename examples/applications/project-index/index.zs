import { Map, Set } from "std/collections";
import fs from "std/fs";

export struct FileRecord {
  path: String;
  contents: String;
  revision: i32;

  function byteLength(): usize {
    return this.contents.byteLength;
  }
}

export struct IndexError {
  path: String;
  message: String;
}

export struct IndexReport {
  record: FileRecord;
  indexedFiles: usize;
  dirty: boolean;
}

export struct ProjectIndex {
  private records: Map<String, FileRecord>;
  private dirtyPaths: Set<String>;

  static function empty(): ProjectIndex {
    return ProjectIndex({
      records: Map<String, FileRecord>(),
      dirtyPaths: Set<String>(),
    });
  }

  function upsert(inout this, in path: String, contents: String): i32 {
    const existing = this.records.get(path);
    const revision = match (in existing) {
      some(record) => record.revision + 1;
      none => 1;
    };

    this.records.set(
      copy path,
      FileRecord({
        path: copy path,
        contents,
        revision,
      })
    );
    this.dirtyPaths.add(copy path);
    return revision;
  }

  function snapshot(in path: String): Option<FileRecord> {
    const found = this.records.get(path);
    return match (in found) {
      some(record) => Option.some(copy record);
      none => Option.none;
    };
  }

  function report(in path: String): Option<IndexReport> {
    const snapshot = this.snapshot(path);
    return match (snapshot) {
      some(record) => Option.some(IndexReport({
        record,
        indexedFiles: this.records.length,
        dirty: this.dirtyPaths.has(path),
      }));
      none => Option.none;
    };
  }

  function markSaved(inout this, in path: String): boolean {
    const removed = this.dirtyPaths.remove(path);
    return match (removed) {
      some(ownedPath) => true;
      none => false;
    };
  }

  function count(): usize {
    return this.records.length;
  }

  function isDirty(in path: String): boolean {
    return this.dirtyPaths.has(path);
  }
}

export function indexFile(inout index: ProjectIndex, in path: String): i32 throws IndexError {
  const loaded = attempt fs.readText(path);
  const contents = match (loaded) {
    success(value) => value;
    failure(message) => throw IndexError({
      path: copy path,
      message,
    });
  };
  return index.upsert(path, contents);
}
