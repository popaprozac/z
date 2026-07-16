const vscode = require("vscode");
const { spawn } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let client = null;

async function activate(context) {
  const extensionPath = realpathSync(context.extensionPath);
  const projectRoot = path.resolve(extensionPath, "../..");
  const serverPath = path.join(projectRoot, "compiler/src/lsp.ts");
  const configuredBun = vscode.workspace.getConfiguration("z").get("bunPath", "bun");
  const userBun = path.join(os.homedir(), ".bun/bin/bun");
  const bunPath = configuredBun === "bun" && existsSync(userBun) ? userBun : configuredBun;
  const output = vscode.window.createOutputChannel("Z Language Server");
  const diagnostics = vscode.languages.createDiagnosticCollection("z");
  context.subscriptions.push(output, diagnostics);

  client = new RpcClient(spawn(process.env.Z_BUN_PATH || bunPath, [serverPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  }), output);
  context.subscriptions.push({ dispose: () => client?.dispose() });

  client.onNotification("textDocument/publishDiagnostics", (params) => {
    const uri = vscode.Uri.parse(params.uri);
    const values = params.diagnostics.map((item) => {
      const diagnostic = new vscode.Diagnostic(toRange(item.range), item.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = item.source || "z";
      return diagnostic;
    });
    diagnostics.set(uri, values);
  });
  client.onNotification("window/logMessage", (params) => output.appendLine(params.message));

  await client.request("initialize", {
    processId: process.pid,
    rootUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString() || null,
    capabilities: {},
  });
  client.notify("initialized", {});

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === "z") didOpen(document);
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === "z") didOpen(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "z") return;
      client.notify("textDocument/didChange", {
        textDocument: { uri: event.document.uri.toString(), version: event.document.version },
        contentChanges: [{ text: event.document.getText() }],
      });
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId !== "z") return;
      client.notify("textDocument/didSave", {
        textDocument: { uri: document.uri.toString() },
        text: document.getText(),
      });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.languageId !== "z") return;
      client.notify("textDocument/didClose", { textDocument: { uri: document.uri.toString() } });
      diagnostics.delete(document.uri);
    }),
  );

  const completionTriggers = [".", ",", "_", ..."abcdefghijklmnopqrstuvwxyz", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider("z", {
    async provideCompletionItems(document, position) {
      const result = await client.request("textDocument/completion", textDocumentPosition(document, position));
      const items = (result?.items || []).map((item) => {
        const completion = new vscode.CompletionItem(item.label, completionKind(item.kind));
        completion.detail = item.detail;
        completion.sortText = item.sortText;
        completion.insertText = item.insertTextFormat === 2
          ? new vscode.SnippetString(item.insertText || item.label)
          : item.insertText || item.label;
        return completion;
      });
      return new vscode.CompletionList(items, Boolean(result?.isIncomplete));
    },
  }, ...completionTriggers));

  context.subscriptions.push(vscode.languages.registerHoverProvider("z", {
    async provideHover(document, position) {
      const result = await client.request("textDocument/hover", textDocumentPosition(document, position));
      if (!result) return null;
      const contents = new vscode.MarkdownString(result.contents.value);
      return new vscode.Hover(contents, result.range ? toRange(result.range) : undefined);
    },
  }));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider("z", {
    async provideDefinition(document, position) {
      const result = await client.request("textDocument/definition", textDocumentPosition(document, position));
      return result ? new vscode.Location(vscode.Uri.parse(result.uri), toRange(result.range)) : null;
    },
  }));

  const semanticLegend = new vscode.SemanticTokensLegend(
    ["namespace", "type", "class", "enum", "function", "method", "property", "variable", "parameter"],
    ["declaration", "readonly", "defaultLibrary"],
  );
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider("z", {
    async provideDocumentSemanticTokens(document) {
      const result = await client.request("textDocument/semanticTokens/full", {
        textDocument: { uri: document.uri.toString() },
      });
      return new vscode.SemanticTokens(new Uint32Array(result?.data || []));
    },
  }, semanticLegend));

  function didOpen(document) {
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: document.uri.toString(),
        languageId: "z",
        version: document.version,
        text: document.getText(),
      },
    });
  }
}

async function deactivate() {
  if (!client) return;
  try {
    await client.request("shutdown", null);
    client.notify("exit", null);
  } finally {
    client.dispose();
    client = null;
  }
}

class RpcClient {
  constructor(process, output) {
    this.process = process;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Map();
    process.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readMessages();
    });
    process.stderr.on("data", (chunk) => output.append(chunk.toString()));
    process.on("error", (error) => vscode.window.showErrorMessage(`Z language server failed: ${error.message}`));
    process.on("exit", (code) => {
      if (code && code !== 0) output.appendLine(`Z language server exited with code ${code}`);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  onNotification(method, callback) {
    this.notifications.set(method, callback);
  }

  readMessages() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!length) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyLength = Number(length);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + bodyLength) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
      } else if (message.method) {
        this.notifications.get(message.method)?.(message.params);
      }
    }
  }

  write(message) {
    const body = JSON.stringify(message);
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  dispose() {
    if (!this.process.killed) this.process.kill();
    for (const pending of this.pending.values()) pending.reject(new Error("Z language server stopped"));
    this.pending.clear();
  }
}

function textDocumentPosition(document, position) {
  return {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  };
}

function toRange(range) {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function completionKind(kind) {
  const values = {
    2: vscode.CompletionItemKind.Method,
    3: vscode.CompletionItemKind.Function,
    5: vscode.CompletionItemKind.Field,
    6: vscode.CompletionItemKind.Variable,
    7: vscode.CompletionItemKind.Class,
    9: vscode.CompletionItemKind.Module,
    10: vscode.CompletionItemKind.Property,
    13: vscode.CompletionItemKind.Enum,
    21: vscode.CompletionItemKind.Constant,
    22: vscode.CompletionItemKind.Struct,
  };
  return values[kind] || vscode.CompletionItemKind.Text;
}

module.exports = { activate, deactivate };
