import sqlite from "sqlite3.h";
import { Note } from "./model.zs";

export function sqliteVersion(): cstring {
  return sqlite.sqlite3_libversion();
}

export function canOpenMemoryDatabase(): boolean {
  let database;
  const status = sqlite.sqlite3_open(":memory:", out database);
  if (status != 0) return false;
  if (database == null) return false;
  return true;
}

export function loadNotes(in path: String): Array<Note> {
  let notes = Array<Note>();
  let database;
  const opened = sqlite.sqlite3_open(path, out database);
  if (opened != 0) return notes;
  if (database == null) return notes;
  const rowStatus = 100;
  const doneStatus = 101;

  let schemaStatement;
  const schemaStatus = sqlite.sqlite3_prepare_v2(
    database,
    "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL)",
    -1,
    out schemaStatement,
    null
  );
  if (schemaStatus != 0) return notes;
  if (schemaStatement == null) return notes;
  if (sqlite.sqlite3_step(schemaStatement) != doneStatus) return notes;

  let seedStatement;
  const seedStatus = sqlite.sqlite3_prepare_v2(
    database,
    "INSERT OR IGNORE INTO notes (id, title, body) VALUES (1, 'Welcome to Z Notes', 'A native desktop application written primarily in Z.'), (2, 'Interop', 'AppKit and sqlite3 arrive through their real native headers.')",
    -1,
    out seedStatement,
    null
  );
  if (seedStatus != 0) return notes;
  if (seedStatement == null) return notes;
  if (sqlite.sqlite3_step(seedStatement) != doneStatus) return notes;

  let queryStatement;
  const queryStatus = sqlite.sqlite3_prepare_v2(
    database,
    "SELECT id, title, body FROM notes ORDER BY id",
    -1,
    out queryStatement,
    null
  );
  if (queryStatus != 0) return notes;
  if (queryStatement == null) return notes;

  let stepStatus = sqlite.sqlite3_step(queryStatement);
  while (stepStatus == rowStatus) {
    const titleBytes = sqlite.sqlite3_column_text(queryStatement, 1);
    if (titleBytes == null) return notes;
    const bodyBytes = sqlite.sqlite3_column_text(queryStatement, 2);
    if (bodyBytes == null) return notes;
    const title = String.from(titleBytes);
    const body = String.from(bodyBytes);
    notes.push(Note({
      id: sqlite.sqlite3_column_int64(queryStatement, 0),
      title,
      body,
    }));
    stepStatus = sqlite.sqlite3_step(queryStatement);
  }
  return notes;
}

export function insertNote(in path: String, in note: Note): boolean {
  let database;
  const opened = sqlite.sqlite3_open(path, out database);
  if (opened != 0) return false;
  if (database == null) return false;
  const doneStatus = 101;

  let statement;
  const query = "INSERT INTO notes (id, title, body) VALUES (?, ?, ?)";
  const prepared = sqlite.sqlite3_prepare_v2(database, query, -1, out statement, null);
  if (prepared != 0) return false;
  if (statement == null) return false;
  if (sqlite.sqlite3_bind_int64(statement, 1, note.id) != 0) return false;
  if (sqlite.sqlite3_bind_text(statement, 2, note.title, -1) != 0) return false;
  if (sqlite.sqlite3_bind_text(statement, 3, note.body, -1) != 0) return false;
  return sqlite.sqlite3_step(statement) == doneStatus;
}
