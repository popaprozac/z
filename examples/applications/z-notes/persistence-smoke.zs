import console from "std/console";
import { Note, NoteStore } from "./model.zs";
import { insertNote, loadNotes } from "./persistence.zs";

function main(): i32 {
  const path = ".z-cache/z-notes-smoke.sqlite3";
  const loadedBefore = attempt loadNotes(path);
  const beforeNotes = match (loadedBefore) {
    success(notes) => notes;
    failure(status) => return status;
  };
  const before = new NoteStore({
    notes: beforeNotes,
    selection: Option<usize>.none,
  });
  const noteId = before.nextNoteId();
  const note = Note({
    id: noteId,
    title: "Ada's native note",
    body: "Bound text keeps quotes like ' safe.",
  });
  const inserted = attempt insertNote(path, note);
  match (inserted) {
    success => {}
    failure(status) => return status;
  }

  const loadedAfter = attempt loadNotes(path);
  const afterNotes = match (loadedAfter) {
    success(notes) => notes;
    failure(status) => return status;
  };
  const after = new NoteStore({
    notes: afterNotes,
    selection: Option<usize>.none,
  });
  let preserved = false;
  after.selectNote(after.noteCount() - 1);
  after.withSelected((in saved) => {
    preserved = saved.title == "Ada's native note"
      && saved.body == "Bound text keeps quotes like ' safe.";
  });
  console.log(`persisted note ${noteId}, before=${before.noteCount()}, after=${after.noteCount()}`);
  return after.noteCount() == before.noteCount() + 1 && preserved ? 0 : 2;
}
