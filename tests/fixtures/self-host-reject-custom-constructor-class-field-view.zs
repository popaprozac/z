class Document {
  title: String;

  constructor(title: String) {
    this.title = title;
  }
}

function main(): i32 {
  const document = new Document("Constructed");
  const title = view document.title;
  return i32(title.byteLength);
}
