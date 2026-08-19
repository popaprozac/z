struct Batch {
  values: Array<i32>;
}

struct Document {
  title: String;
}

function addFirstTwo(values: Slice<i32>): i32 {
  const [first, ...remaining] = view values;
  return first + remaining[0];
}

function firstTitleLength(values: Slice<Document>): usize {
  const [first, ...remaining] = view values;
  return first.title.byteLength + remaining.length;
}

function main(): i32 {
  const batch = Batch({ values: Array<i32>(20, 21, 22) });
  const [first, _, third] = batch.values;
  const [repeated, second] = batch.values;
  const [head, ...remaining] = view batch.values;
  if (remaining.length != 2) return 3;
  if (remaining[0] != 21 || remaining[1] != 22) return 4;
  if (head != 20) return 5;
  if (addFirstTwo(remaining) != 43) return 6;
  if (addFirstTwo(batch.values) != 41) return 7;

  const empty = Array<i32>();
  const [...nothing] = view empty;
  if (nothing.length != 0) return 8;

  let documents = Array<Document>(
    Document({ title: "draft" }),
    Document({ title: "published" })
  );
  if (firstTitleLength(documents) != 6) return 9;
  const [current, ...remainingDocuments] = view documents;
  if (current.title != "draft") return 10;
  if (remainingDocuments.length != 1) return 11;
  if (remainingDocuments[0].title != "published") return 12;
  if (firstTitleLength(remainingDocuments) != 9) return 13;
  documents.push(Document({ title: "archived" }));

  return first + third + repeated + second - 83;
}
