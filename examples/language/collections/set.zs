import { Set } from "std/collections";

function main(): i32 {
  let openDocuments = Set<String>();

  if (!openDocuments.add("notes/ideas.md")) return 1;
  if (!openDocuments.add("notes/todo.md")) return 2;
  if (openDocuments.add("notes/ideas.md")) return 3;
  if (!openDocuments.has("notes/todo.md")) return 4;

  const closed = openDocuments.remove("notes/todo.md");
  const closedKnownDocument = match (closed) {
    some(path) => path == "notes/todo.md";
    none => false;
  };
  if (!closedKnownDocument || openDocuments.length != 1) return 5;

  openDocuments.clear();
  return openDocuments.length == 0 ? 0 : 6;
}
