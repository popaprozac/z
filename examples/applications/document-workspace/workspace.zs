import {
  DocumentSession,
  WorkspaceError,
  openDocument,
} from "./document.zs";

export struct DocumentWorkspace {
  documents: Array<DocumentSession>;

  static function empty(): DocumentWorkspace {
    return DocumentWorkspace({ documents: Array<DocumentSession>() });
  }

  function registerDocument(inout this, title: String, documentId: i32): i32 {
    const opened = openDocument(title, documentId);
    return match (opened) {
      opened(document) => {
        const registeredId = document.documentId();
        this.documents.push(document);
        select registeredId;
      }
      rejected(error) => 0 - error.code;
    };
  }

  function findDocument(documentId: i32): Option<view DocumentSession> {
    let index: usize = 0;
    while (index < this.documents.length) {
      if (this.documents[index].documentId() == documentId) {
        return Option.some(this.documents[index]);
      }
      index = index + 1;
    }
    return Option.none;
  }

  function endpoints(): DocumentSelection {
    return DocumentSelection({
      first: view this.documents[0],
      last: view this.documents[this.documents.length - 1],
    });
  }

  function saveAll(inout this): i32 throws WorkspaceError {
    if (this.documents.length == 0) {
      throw WorkspaceError({
        code: 200,
        message: `cannot save an empty workspace (code ${200})`,
      });
    }
    let index: usize = 0;
    let saved: i32 = 0;
    while (index < this.documents.length) {
      this.documents[index].recordSave();
      saved = saved + 1;
      index = index + 1;
    }
    return saved;
  }

  function documentCount(): usize {
    return this.documents.length;
  }
}

export struct DocumentSelection {
  first: view DocumentSession;
  last: view DocumentSession;
}

export function saveWorkspace(inout workspace: DocumentWorkspace): i32 throws WorkspaceError {
  return try workspace.saveAll();
}

export function findWorkspaceDocument(
  documentId: i32,
  in workspace: DocumentWorkspace
): Option<view DocumentSession> {
  return workspace.findDocument(documentId);
}

export function selectWorkspaceEndpoints(
  in workspace: DocumentWorkspace
): DocumentSelection {
  return workspace.endpoints();
}
