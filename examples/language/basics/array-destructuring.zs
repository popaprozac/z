import console from "std/console";

struct Document {
  title: String;
}

function sum(values: Slice<i32>): i32 {
  const [first, ...remaining] = view values;
  let total = first;
  for (const value of remaining) {
    total = total + value;
  }
  return total;
}

function main(): i32 {
  const [literalFirst, literalSecond] = [20, 22];

  const fixed = [10, 20, 30, 40];
  const [first, _, third] = fixed;
  const [fixedHead, ...fixedRemaining] = view fixed;

  let values = Array<i32>(1, 2, 3, 4);
  const [head, ...tail] = view values;
  const observed = head + sum(tail) + fixedHead + sum(fixedRemaining);
  values.push(5);

  let documents = Array<Document>(
    Document({ title: "draft" }),
    Document({ title: "published" })
  );
  const [current, ...remaining] = view documents;
  console.log(`${current.title}: ${remaining.length}`);
  documents.push(Document({ title: "archived" }));

  return literalFirst + literalSecond + first + third + observed - 192;
}
