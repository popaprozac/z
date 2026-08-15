import { ParsedFile, inspect, parseValue } from "./parsed.zs";

function consume(parsed: ParsedFile): i32 {
  return inspect(in parsed);
}

function main(): i32 {
  const parsed = parseValue(42);
  return consume(move parsed) - 42;
}
