struct Batch {
  values: Array<i32>;
}

struct Document {
  title: String;
}

function main(): i32 {
  const batch = Batch({ values: Array<i32>(20, 21, 22) });
  const [first, _, third] = batch.values;
  const [repeated, second] = batch.values;
  const [head, ...remaining] = view batch.values;
  if (remaining.length != 2) return 3;
  if (remaining[0] != 21 || remaining[1] != 22) return 4;
  if (head != 20) return 5;

  const empty = Array<i32>();
  const [...nothing] = view empty;
  if (nothing.length != 0) return 6;

  let documents = Array<Document>(
    Document({ title: "draft" }),
    Document({ title: "published" })
  );
  const [current, ...remainingDocuments] = view documents;
  if (current.title != "draft") return 7;
  if (remainingDocuments.length != 1) return 8;
  if (remainingDocuments[0].title != "published") return 9;
  documents.push(Document({ title: "archived" }));

  return first + third + repeated + second - 83;
}
