#!/usr/bin/env bun

import {
  completions,
  definition,
  diagnostics,
  hover,
  offsetAt,
  semanticTokens,
  semanticTokenModifiers,
  semanticTokenTypes,
  type Position,
} from "./language-service.ts";

type JsonRpcId = number | string;
type JsonRpcMessage = {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: any;
};

type OpenDocument = {
  readonly uri: string;
  readonly languageId: string;
  version: number;
  text: string;
};

const documents = new Map<string, OpenDocument>();
const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
let input = Buffer.alloc(0);
let shuttingDown = false;

process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  readMessages();
});
process.stdin.resume();

function readMessages(): void {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const length = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1];
    if (!length) {
      input = input.subarray(headerEnd + 4);
      continue;
    }
    const bodyLength = Number(length);
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + bodyLength) return;
    const body = input.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
    input = input.subarray(bodyStart + bodyLength);
    void dispatch(JSON.parse(body) as JsonRpcMessage);
  }
}

async function dispatch(message: JsonRpcMessage): Promise<void> {
  try {
    if (!message.method) return;
    switch (message.method) {
      case "initialize":
        respond(message.id!, {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
            completionProvider: { triggerCharacters: [".", ","] },
            hoverProvider: true,
            definitionProvider: true,
            semanticTokensProvider: {
              legend: { tokenTypes: semanticTokenTypes, tokenModifiers: semanticTokenModifiers },
              full: true,
            },
          },
          serverInfo: { name: "z-language-server", version: "0.1.0" },
        });
        return;
      case "initialized":
        return;
      case "shutdown":
        shuttingDown = true;
        respond(message.id!, null);
        return;
      case "exit":
        process.exit(shuttingDown ? 0 : 1);
      case "textDocument/didOpen": {
        const document = message.params.textDocument as OpenDocument;
        documents.set(document.uri, { ...document });
        scheduleDiagnostics(document.uri, 0);
        return;
      }
      case "textDocument/didChange": {
        const document = documents.get(message.params.textDocument.uri);
        const change = message.params.contentChanges.at(-1);
        if (document && change) {
          document.text = change.text;
          document.version = message.params.textDocument.version;
          scheduleDiagnostics(document.uri, 150);
        }
        return;
      }
      case "textDocument/didSave": {
        const document = documents.get(message.params.textDocument.uri);
        if (document && typeof message.params.text === "string") document.text = message.params.text;
        if (document) scheduleDiagnostics(document.uri, 0);
        return;
      }
      case "textDocument/didClose":
        clearDiagnosticTimer(message.params.textDocument.uri);
        documents.delete(message.params.textDocument.uri);
        notify("textDocument/publishDiagnostics", { uri: message.params.textDocument.uri, diagnostics: [] });
        return;
      case "textDocument/completion": {
        const document = documents.get(message.params.textDocument.uri);
        const items = document
          ? completions(document.text, fileName(document.uri), offsetAt(document.text, message.params.position as Position))
          : [];
        respond(message.id!, { isIncomplete: true, items });
        return;
      }
      case "textDocument/hover": {
        const document = documents.get(message.params.textDocument.uri);
        const result = document
          ? hover(document.text, fileName(document.uri), offsetAt(document.text, message.params.position as Position))
          : null;
        respond(message.id!, result);
        return;
      }
      case "textDocument/definition": {
        const document = documents.get(message.params.textDocument.uri);
        const result = document
          ? definition(document.text, document.uri, offsetAt(document.text, message.params.position as Position))
          : null;
        respond(message.id!, result);
        return;
      }
      case "textDocument/semanticTokens/full": {
        const document = documents.get(message.params.textDocument.uri);
        respond(message.id!, document ? semanticTokens(document.text, fileName(document.uri)) : { data: [] });
        return;
      }
      default:
        if (message.id !== undefined) respond(message.id, null);
    }
  } catch (error) {
    if (message.id !== undefined) {
      respondError(message.id, -32603, error instanceof Error ? error.message : String(error));
    } else {
      notify("window/logMessage", { type: 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function publishDiagnostics(uri: string): void {
  const document = documents.get(uri);
  if (!document) return;
  notify("textDocument/publishDiagnostics", {
    uri,
    version: document.version,
    diagnostics: diagnostics(document.text, fileName(uri)),
  });
}

function scheduleDiagnostics(uri: string, delay: number): void {
  clearDiagnosticTimer(uri);
  diagnosticTimers.set(uri, setTimeout(() => {
    diagnosticTimers.delete(uri);
    publishDiagnostics(uri);
  }, delay));
}

function clearDiagnosticTimer(uri: string): void {
  const timer = diagnosticTimers.get(uri);
  if (timer) clearTimeout(timer);
  diagnosticTimers.delete(uri);
}

function respond(id: JsonRpcId, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id: JsonRpcId, code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: "2.0", method, params });
}

function write(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function fileName(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri;
}
