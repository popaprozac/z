import console from "std/console";

type Transform = (context: i32) => i32;

function double(context: i32): i32 {
  return context * 2;
}

function apply(in operation: Transform, value: i32): i32 {
  return operation(value);
}

function applyInline(
  in operation: (value: i32) => i32,
  value: i32
): i32 {
  return operation(value);
}

readonly class TransformAdapter {
  operation: Transform;

  function apply(value: i32): i32 {
    return this.operation(value);
  }
}

function createAdapter(offset: i32): TransformAdapter {
  const operation: Transform = move (value: i32): i32 => value + offset;
  return new TransformAdapter({ operation });
}

function main(): i32 {
  const direct: Transform = double;
  const offset = 2;
  const add = (context: i32): i32 => context + offset;
  const doubled = apply(in direct, 20);
  const adjusted = add(40);
  const inlineDoubled = applyInline(in direct, 20);
  const adapter = createAdapter(2);
  const adapted = adapter.apply(40);

  console.log(
    `doubled=${doubled} adjusted=${adjusted} inline=${inlineDoubled} adapted=${adapted}`
  );
  return doubled + adjusted + inlineDoubled + adapted - 164;
}
