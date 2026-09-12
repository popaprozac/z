import console from "std/console";

class Document {
  title: String;
  constructor(title: String) { this.title = title; }
  deinit { console.log(this.title); }
}

struct Library { document: Document; }
struct Failure { message: String; }

function makeOption(fail: boolean): Option<String> throws Failure {
  if (fail) throw Failure({ message: "subject failed" });
  return Option<String>.some("new text");
}

function assignSubject(inout text: String, fail: boolean): void throws Failure {
  text = match (try makeOption(fail)) {
    some(value) => value;
    none => "empty";
  };
}

function selectedIndex(): usize {
  console.log("must not evaluate index");
  return 0;
}

function earlyIndex(inout values: Array<i32>, option: Option<i32>): void {
  values[selectedIndex()] = match (option) {
    some(_) => return;
    none => -1;
  };
}

function main(): i32 {
  const text = "source text";
  const input = Option<String>.some(text.copyBytes(0, text.byteLength));
  let selected = text.copyBytes(0, 8);
  selected = match (in input) {
    some(value) => copy value;
    none => "missing";
  };
  match (in input) { some(value) => { if (value != selected) return 1; } none => return 2; }
  const failed = attempt assignSubject(inout selected, true);
  match (failed) { success => return 3; failure(error) => console.log(error.message); }
  if (selected != "source text") return 4;
  const updated = attempt assignSubject(inout selected, false);
  match (updated) { success => {} failure(_) => return 5; }
  if (selected != "new text") return 6;

  let option = Option<String>.some(text.copyBytes(0, 10));
  option = match (in input) {
    some(value) => Option<String>.some(copy value);
    none => Option<String>.none;
  };
  match (in option) { some(value) => { if (value != "source text") return 7; } none => return 8; }

  const shared = new Document("shared");
  const source = Option<Document>.some(shared);
  let document = new Document("old local");
  document = match (in source) { some(value) => value; none => new Document("unused"); };
  let library = Library({ document: new Document("old field") });
  library.document = match (in source) { some(value) => value; none => new Document("unused"); };
  if (shared.title != document.title || shared.title != library.document.title) return 9;

  let values = Array<i32>(42);
  earlyIndex(inout values, Option<i32>.some(1));
  if (values[0] != 42) return 10;
  return 0;
}
