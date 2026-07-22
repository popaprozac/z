import console from "std/console";
import process from "std/process";
import {
  IndexReport,
  ProjectIndex,
  indexFile,
} from "./index.zs";

function publish(report: IndexReport): void {
  console.log(
    `indexed ${report.record.path}: ${report.record.byteLength()} bytes,`,
    `revision ${report.record.revision}, files ${report.indexedFiles}, dirty=${report.dirty}`
  );
}

function main(): i32 {
  const paths = process.args();
  if (paths.length == 0) {
    console.error("usage: project-index <file> [file ...]");
    return 2;
  }

  let index = ProjectIndex.empty();
  for (const path of paths) {
    const indexed = attempt indexFile(inout index, path);
    match (indexed) {
      success(revision) => console.log(`recorded ${path} at revision ${revision}`);
      failure(error) => {
        console.error(`could not index ${error.path}: ${error.message}`);
        return 1;
      }
    }
  }

  const result = index.report(paths[0]);
  match (result) {
    some(report) => publish(move report);
    none => {
      console.error(`index lost ${paths[0]}`);
      return 1;
    }
  }
  const summary = index.summary();
  console.log(
    `summary: ${summary.indexedFiles} files, ${summary.indexedBytes} bytes,`,
    `${summary.dirtyFiles} dirty paths (${summary.dirtyPathBytes} path bytes)`
  );
  return 0;
}
