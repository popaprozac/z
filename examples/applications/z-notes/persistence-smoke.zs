import console from "std/console";
import { NoteStore } from "./model.zs";
import { insertGeneratedNote, loadNotes } from "./persistence.zs";

function main(): i32 {
  const path = ".z-cache/z-notes-smoke.sqlite3";
  const before = new NoteStore({
    notes: loadNotes(path),
    selection: Option<usize>.none,
  });
  const noteId = before.nextNoteId();
  if (!insertGeneratedNote(path, noteId)) return 1;

  const after = new NoteStore({
    notes: loadNotes(path),
    selection: Option<usize>.none,
  });
  console.log(`persisted note ${noteId}, before=${before.noteCount()}, after=${after.noteCount()}`);
  return after.noteCount() == before.noteCount() + 1 ? 0 : 2;
}
