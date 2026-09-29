import console from "std/console";

function noisy(in values: Array<String>): boolean {
  console.log(`evaluated ${values.length}`);
  return values.length > 1;
}

function named(in text: String): boolean {
  console.log(`named ${text}`);
  return text.byteLength > 2;
}

function main(): i32 {
  const ready = true;
  const idle = false;
  if (ready || noisy(Array<String>("skipped"))) console.log("or taken");
  if (idle && noisy(Array<String>("skipped"))) console.log("and taken");
  if (idle || noisy(Array<String>("a", "b"))) console.log("or right");
  if (ready && named(`r${1}`)) console.log("and right");
  const both = noisy(Array<String>("x")) || named(`n${2}${2}`);
  if (both) console.log("both");
  let n = 0;
  while (n < 3 && noisy(Array<String>("w", "v"))) {
    n = n + 1;
    if (n == 1) continue;
  }
  let m = 0;
  while (named(`m${m}${m}`)) {
    m = m + 1;
    if (m == 2) break;
  }
  console.log(`n=${n} m=${m}`);
  return 0;
}
