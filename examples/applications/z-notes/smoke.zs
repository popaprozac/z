import console from "std/console";
import { Note, NoteStore } from "./model.zs";
import { canOpenMemoryDatabase, sqliteVersion } from "./persistence.zs";

function main(): i32 {
  const store = new NoteStore({
    notes: Array<Note>(),
    selection: Option<usize>.none,
  });
  store.add(Note({ id: 1, title: "Smoke Test", body: "Z Notes model" }));
  store.selectNote(0);
  const rendered = store.renderText();
  const databaseReady = canOpenMemoryDatabase();
  console.log(`z-notes sqlite=${sqliteVersion()}, notes=${store.noteCount()}, database=${databaseReady}`);
  return store.noteCount() == 1
    && rendered == "# Smoke Test\nZ Notes model\n\n"
    && databaseReady ? 0 : 1;
}
