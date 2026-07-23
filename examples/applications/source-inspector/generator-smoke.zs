import console from "std/console";
import { Generator } from "std/iteration";
import {
  LexerError,
  Token,
  TokenKind,
  tokenKindName,
} from "../../../compiler/frontend/lexer.zs";
import {
  GeneratorScanSummary,
  streamSource,
} from "./generator-scanner.zs";

function inspect(
  tokens: Generator<Token, GeneratorScanSummary, LexerError>
): i32 throws LexerError {
  let running = true;
  let identifiers: usize = 0;

  while (running) {
    const step = try tokens.next();
    match (step) {
      yielded(token) => {
        if (token.kind == TokenKind.identifier) {
          identifiers = identifiers + 1;
          const kind = tokenKindName(token.kind);
          console.log(`${kind} ${token.text}`);
        }
      }
      complete(summary) => {
        console.log(
          `summary bytes=${summary.byteCount} lines=${summary.lineCount} tokens=${summary.tokenCount} identifiers=${summary.identifierCount}`
        );
        running = false;
      }
    }
  }

  return identifiers == 2 ? 0 : 1;
}

function main(): i32 {
  const valid = attempt inspect(streamSource("const answer = value + 42;\n"));
  const validStatus = match (valid) {
    success(status) => status;
    failure(error) => 2;
  };
  if (validStatus != 0) return validStatus;

  return match (attempt inspect(streamSource("@"))) {
    success(status) => 3;
    failure(error) => {
      console.log(`error ${error.line}:${error.column} ${error.message}`);
      select error.line == 1 && error.column == 1 ? 0 : 4;
    }
  };
}
