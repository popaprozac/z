import console from "std/console";

class Document {
  title: String;
  revision: i32;
}

function publish(inout document: Document, title: String): void {
  document.title = title;
  document.revision = document.revision + 1;
}

function main(): i32 {
  let document = new Document({ title: "Draft", revision: 0 });
  const inspector = document;

  // `inout` temporarily has exclusive access to the shared class identity.
  // The compiler suspends competing direct aliases only for this call.
  publish(inout document, "Published");

  // The alias is available again immediately after the bounded operation.
  console.log(`${inspector.title} revision ${inspector.revision}`);
  return 0;
}
