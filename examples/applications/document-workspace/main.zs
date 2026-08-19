import console from "std/console";
import {
  liveDocumentLeases,
  movedDocumentLeases,
} from "./document.zs";
import {
  DocumentWorkspace,
  findWorkspaceDocument,
  saveWorkspace,
} from "./workspace.zs";

struct WorkspaceRunSummary {
  registered: usize;
  saved: i32;
  foundDocumentId: i32;
  foundSaveCount: i32;
  rejectedCode: i32;
  emptySaveCode: i32;
}

function exerciseDocumentWorkspace(): WorkspaceRunSummary {
  let workspace = DocumentWorkspace.empty();

  const emptySave = attempt saveWorkspace(inout workspace);
  const emptySaveCode = match (emptySave) {
    success(saved) => 0 - saved;
    failure(error) => error.code;
  };

  const rejectedStatus = workspace.registerDocument("Invalid draft", -1);
  workspace.registerDocument("Roadmap", 40);
  workspace.registerDocument("Release notes", 42);

  const foundBeforeMutation = findWorkspaceDocument(42, in workspace);
  const foundDocumentId = match (in foundBeforeMutation) {
    some(document) => document.documentId();
    none => -1;
  };

  // The optional view ended with the match, so growing the workspace is safe.
  workspace.registerDocument("API guide", 43);

  const saveResult = attempt saveWorkspace(inout workspace);
  const saved = match (saveResult) {
    success(count) => count;
    failure(error) => {
      console.error(`save failed: ${error.message}`);
      select 0 - error.code;
    }
  };

  const foundAfterSave = workspace.findDocument(42);
  const foundSaveCount = match (in foundAfterSave) {
    some(document) => document.saveCount();
    none => -1;
  };

  return WorkspaceRunSummary({
    registered: workspace.documentCount(),
    saved,
    foundDocumentId,
    foundSaveCount,
    rejectedCode: 0 - rejectedStatus,
    emptySaveCode,
  });
}

function main(): i32 {
  const summary = exerciseDocumentWorkspace();
  const live = liveDocumentLeases();
  const moves = movedDocumentLeases();
  console.log(
    `workspace registered=${summary.registered}, saved=${summary.saved}, found=${summary.foundDocumentId},`,
    `save count=${summary.foundSaveCount}, rejected=${summary.rejectedCode}, empty save=${summary.emptySaveCode},`,
    `native moves=${moves}, live=${live}`
  );

  if (summary.registered != 3) return 1;
  if (summary.saved != 3) return 2;
  if (summary.foundDocumentId != 42) return 3;
  if (summary.foundSaveCount != 1) return 4;
  if (summary.rejectedCode != 100) return 5;
  if (summary.emptySaveCode != 200) return 6;
  return live;
}
