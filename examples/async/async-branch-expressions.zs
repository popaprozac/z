import console from "std/console";

async function flag(id: i32, value: boolean): boolean {
  console.log(`flag ${id}`);
  return value;
}

async function number(id: i32): i32 {
  console.log(`number ${id}`);
  return id;
}

async function main(): i32 {
  const skippedAnd = false && await flag(1, true);
  const takenAnd = true && await flag(2, true);
  const skippedOr = true || await flag(3, false);
  const takenOr = false || await flag(4, true);

  const ternary = await flag(5, false)
    ? await number(50)
    : await number(51);

  const selected = if (await flag(6, true)) {
    select await number(60);
  } else {
    select await number(61);
  };

  const nested = (false || await flag(7, true)) && await flag(8, true);
  const nestedTernary = (false || await flag(9, true))
    ? await number(70)
    : await number(71);

  if (false && await flag(10, true)) return 1;
  if (!(true || await flag(11, false))) return 1;

  let iterations = 0;
  while (iterations < 1 && await flag(12, true)) {
    iterations = iterations + 1;
  }

  if (!skippedAnd && takenAnd && skippedOr && takenOr && nested && iterations == 1) {
    return ternary + selected + nestedTernary - 181;
  }
  return 1;
}
