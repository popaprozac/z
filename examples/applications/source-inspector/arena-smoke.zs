import console from "std/console";
import fs from "std/fs";
import { Arena } from "std/memory";
import {
  TokenKind,
  tokenize,
} from "../../../compiler/frontend/lexer.zs";

struct TokenCoordinate {
  offset: usize;
  line: usize;
  column: usize;
  byteLength: usize;
}

function inspectWithScratch(in source: String): usize throws String {
  const tokenResult = attempt tokenize(source);
  const tokens = match (tokenResult) {
    success(tokens) => tokens;
    failure(error) => throw `lexer error at ${error.line}:${error.column}: ${error.message}`;
  };

  let scratch = Arena({ initialCapacity: 4096 });
  let tokenCount: usize = 0;
  let checksum: usize = 0;
  for (const token of tokens) {
    if (token.kind == TokenKind.eof) continue;
    const coordinate = scratch.create(TokenCoordinate({
      offset: token.offset,
      line: token.line,
      column: token.column,
      byteLength: token.text.byteLength,
    }));
    tokenCount = tokenCount + 1;
    checksum = checksum.wrappingAdd(coordinate.offset);
    checksum = checksum.wrappingAdd(coordinate.line);
    checksum = checksum.wrappingAdd(coordinate.column);
    checksum = checksum.wrappingAdd(coordinate.byteLength);
  }
  scratch.reset();
  console.log(`inspected ${tokenCount} compiler tokens with checksum ${checksum}`);
  return tokenCount;
}

function runInspection(): i32 throws String {
  const source = try fs.readText("compiler/frontend/lexer.zs");
  const tokenCount = try inspectWithScratch(source);
  return tokenCount > 0 ? 0 : 1;
}

function main(): i32 {
  return match (attempt runInspection()) {
    success(exitCode) => exitCode;
    failure(message) => {
      console.error(message);
      select 1;
    }
  };
}
