import { desktop } from "../../../tests/fixtures/document-lease.hpp";

export struct WorkspaceError {
  code: i32;
  message: String;
}

export struct DocumentSession {
  title: String;
  lease: desktop.DocumentLease;

  function documentId(): i32 {
    return this.lease.documentId();
  }

  function recordSave(inout this): void {
    this.lease.recordSave();
  }

  function saveCount(): i32 {
    return this.lease.saveCount();
  }
}

export enum DocumentOpenResult {
  opened DocumentSession,
  rejected WorkspaceError,
}

export function openDocument(title: String, documentId: i32): DocumentOpenResult {
  if (documentId <= 0) {
    return DocumentOpenResult.rejected(WorkspaceError({
      code: 100,
      message: `document IDs must be positive (received ${documentId})`,
    }));
  }
  return DocumentOpenResult.opened(DocumentSession({
    title,
    lease: desktop.DocumentLease(documentId),
  }));
}

export function liveDocumentLeases(): i32 {
  return desktop.DocumentLease.liveCount();
}

export function movedDocumentLeases(): i32 {
  return desktop.DocumentLease.moveCount();
}
