import console from "std/console";
import { thread } from "std/thread";
import { delay } from "std/time";
import { Note } from "./model.zs";
import { loadNotesFromPath } from "./persistence.zs";

async function main(): i32 {
  const path: String = ".z-cache/z-notes-background-smoke.sqlite3";
  const loadPath = copy path;
  const loadTask = thread.spawn(async move (): Array<Note> throws i32 => {
    await delay(1);
    return try loadNotesFromPath(loadPath);
  });

  const loaded = attempt await loadTask;
  return match (loaded) {
    success(notes) => {
      console.log(`background notes=${notes.length}`);
      select i32(notes.length) - 2;
    }
    failure(status) => status;
  };
}
