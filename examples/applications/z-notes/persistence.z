import sqlite from "sqlite3.h";

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
