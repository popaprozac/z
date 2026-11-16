// A mutating method called on an Array element inside an `inout this` method
// needs mutable element access.
import console from "std/console";

struct Session {
  saves: i32;
  label: String;

  function recordSave(inout this): void {
    this.saves = this.saves + 1;
  }
}

struct Workspace {
  documents: Array<Session>;

  function saveAll(inout this): void {
    let index: usize = 0;
    while (index < this.documents.length) {
      this.documents[index].recordSave();
      index = index + 1;
    }
  }
}

function main(): i32 {
  let documents = Array<Session>();
  documents.push(Session({ saves: 0, label: `doc` }));
  let workspace = Workspace({ documents });
  workspace.saveAll();
  console.log(`saves=${workspace.documents[0].saves}`);
  return 0;
}
