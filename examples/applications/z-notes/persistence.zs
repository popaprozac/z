import sqlite from "sqlite3.h";
import { Note } from "./model.zs";

export function sqliteVersion(): cstring {
  return sqlite.sqlite3_libversion();
}

export function canOpenMemoryDatabase(): boolean {
  let database;
  const opened = attempt sqlite.sqlite3_open(":memory:", out database);
  return match (opened) {
    success => database != null;
    failure(status) => false;
  };
}

export class NoteDatabase {
  private database: sqlite.sqlite3;

  constructor(in path: String) throws i32 {
    let database;
    try sqlite.sqlite3_open(path, out database);
    if (database == null) throw -1;
    this.database = move database;
  }

  function loadNotes(): Array<Note> throws i32 {
    let notes = Array<Note>();
    const rowStatus = sqlite.SQLITE_ROW;
    const doneStatus = sqlite.SQLITE_DONE;

    let schemaStatement;
    try sqlite.sqlite3_prepare_v2(
      this.database,
      "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL)",
      -1,
      out schemaStatement,
      null
    );
    if (schemaStatement == null) throw -1;
    const schemaStatus = sqlite.sqlite3_step(schemaStatement);
    if (schemaStatus != doneStatus) throw schemaStatus;

    let seedStatement;
    try sqlite.sqlite3_prepare_v2(
      this.database,
      "INSERT OR IGNORE INTO notes (id, title, body) VALUES (1, 'Welcome to Z Notes', 'A native desktop application written primarily in Z.'), (2, 'Interop', 'AppKit and sqlite3 arrive through their real native headers.')",
      -1,
      out seedStatement,
      null
    );
    if (seedStatement == null) throw -1;
    const seedStatus = sqlite.sqlite3_step(seedStatement);
    if (seedStatus != doneStatus) throw seedStatus;

    let queryStatement;
    try sqlite.sqlite3_prepare_v2(
      this.database,
      "SELECT id, title, body FROM notes ORDER BY id",
      -1,
      out queryStatement,
      null
    );
    if (queryStatement == null) throw -1;

    let stepStatus = sqlite.sqlite3_step(queryStatement);
    while (stepStatus == rowStatus) {
      const titleBytes = sqlite.sqlite3_column_text(queryStatement, 1);
      if (titleBytes == null) throw -1;
      const bodyBytes = sqlite.sqlite3_column_text(queryStatement, 2);
      if (bodyBytes == null) throw -1;
      const title = String.from(titleBytes);
      const body = String.from(bodyBytes);
      notes.push(Note({
        id: sqlite.sqlite3_column_int64(queryStatement, 0),
        title,
        body,
      }));
      stepStatus = sqlite.sqlite3_step(queryStatement);
    }
    if (stepStatus != doneStatus) throw stepStatus;
    return notes;
  }

  function insertNote(in note: Note): void throws i32 {
    const doneStatus = sqlite.SQLITE_DONE;
    let statement;
    const query = "INSERT INTO notes (id, title, body) VALUES (?, ?, ?)";
    try sqlite.sqlite3_prepare_v2(this.database, query, -1, out statement, null);
    if (statement == null) throw -1;
    try sqlite.sqlite3_bind_int64(statement, 1, note.id);
    try sqlite.sqlite3_bind_text(statement, 2, note.title, -1);
    try sqlite.sqlite3_bind_text(statement, 3, note.body, -1);
    const status = sqlite.sqlite3_step(statement);
    if (status != doneStatus) throw status;
  }
}

export function loadNotesFromPath(path: String): Array<Note> throws i32 {
  const database = try new NoteDatabase(path);
  return try database.loadNotes();
}

export function saveNoteToPath(path: String, note: Note): Note throws i32 {
  const database = try new NoteDatabase(path);
  try database.insertNote(note);
  return note;
}
