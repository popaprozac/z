export struct Note {
  id: i64;
  title: String;
  body: String;
}

export class NoteStore {
  notes: Array<Note>;
  selection: Option<usize>;

  function add(inout this, note: Note): void {
    this.notes.push(note);
  }

  function selectNote(inout this, index: usize): boolean {
    if (index >= this.notes.length) return false;
    this.selection = Option.some(index);
    return true;
  }

  function clearSelection(inout this): void {
    this.selection = Option.none;
  }

  function noteCount(): usize {
    return this.notes.length;
  }

  function withSelected(in visit: (in note: Note) => void): boolean {
    return match (in this.selection) {
      some(index) => {
        visit(this.notes[index]);
        select true;
      }
      none => false;
    };
  }
}
