import { TextBuffer } from "std/text";

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

  function tableRowCount(): isize {
    let count: isize = 0;
    for (const note of this.notes) {
      if (note.id < 0) return 0;
      count = count + 1;
    }
    return count;
  }

  function nextNoteId(): i64 {
    let next: i64 = 1;
    for (const note of this.notes) {
      if (note.id >= next) next = note.id + 1;
    }
    return next;
  }

  function renderText(): String {
    let output = TextBuffer();
    for (const note of this.notes) {
      output.append(`# ${note.title}\n${note.body}\n\n`);
    }
    return output.finish();
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

  function withRow(row: isize, in visit: (in note: Note) => void): boolean {
    if (row < 0) return false;
    let current: isize = 0;
    for (const note of this.notes) {
      if (current == row) {
        visit(note);
        return true;
      }
      current = current + 1;
    }
    return false;
  }
}
