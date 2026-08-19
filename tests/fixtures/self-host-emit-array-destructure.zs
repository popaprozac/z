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

  let documents = Array<Document>(
    Document({ title: "draft" }),
    Document({ title: "published" })
  );
  const [current, published] = view documents;
  if (current.title != "draft") return 1;
  if (published.title != "published") return 2;
  documents.push(Document({ title: "archived" }));

  return first + third + repeated + second - 83;
}
