import console from "std/console";
import objc from "std/objc";
import AppKit from "AppKit/AppKit.h";
import { Note, NoteStore } from "./model.zs";
import { canOpenMemoryDatabase, sqliteVersion } from "./persistence.zs";

function seed(store: NoteStore): void {
  store.add(Note({
    id: 1,
    title: "Welcome to Z Notes",
    body: "A native desktop application written primarily in Z.",
  }));
  store.add(Note({
    id: 2,
    title: "Interop",
    body: "AppKit and sqlite3 arrive through their real native headers.",
  }));
  store.selectNote(0);
}

function main(): i32 {
  const store = new NoteStore({
    notes: Array<Note>(),
    selection: Option<usize>.none,
  });
  seed(store);

  console.log(`sqlite=${sqliteVersion()}, database=${canOpenMemoryDatabase()}, notes=${store.noteCount()}`);
  store.withSelected((in note) => {
    console.log(`selected note ${note.id}: ${note.title}`);
  });

  const app = AppKit.NSApplication.sharedApplication;
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

  const frame = AppKit.NSMakeRect(0.0, 0.0, 820.0, 560.0);
  const style = AppKit.NSWindowStyleMaskTitled
    | AppKit.NSWindowStyleMaskClosable
    | AppKit.NSWindowStyleMaskMiniaturizable
    | AppKit.NSWindowStyleMaskResizable;
  const window = AppKit.NSWindow.alloc().initWithContentRect(
    frame,
    styleMask: style,
    backing: AppKit.NSBackingStoreBuffered,
    defer: false
  );
  window.title = `Z Notes — ${store.noteCount()} notes`;

  const content = window.contentView;
  if (content == null) return 1;

  const heading = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 500.0, 500.0, 32.0)
  );
  heading.stringValue = "Z Notes";
  heading.bezeled = false;
  heading.drawsBackground = false;
  heading.editable = false;
  heading.selectable = false;
  content.addSubview(heading);

  const selectedLabel = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 456.0, 620.0, 24.0)
  );
  selectedLabel.stringValue = "No note selected";
  selectedLabel.bezeled = false;
  selectedLabel.drawsBackground = false;
  selectedLabel.editable = false;
  selectedLabel.selectable = false;
  content.addSubview(selectedLabel);
  store.withSelected((in note) => {
    selectedLabel.stringValue = `Selected: ${note.title}`;
  });

  const statusLabel = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 24.0, 620.0, 24.0)
  );
  statusLabel.stringValue = `Ready — ${store.noteCount()} notes`;
  statusLabel.bezeled = false;
  statusLabel.drawsBackground = false;
  statusLabel.editable = false;
  statusLabel.selectable = false;
  content.addSubview(statusLabel);

  const addButton = AppKit.NSButton.alloc().initWithFrame(
    AppKit.NSMakeRect(680.0, 20.0, 112.0, 32.0)
  );
  addButton.title = "Add Note";

  let nextId: i64 = 3;
  const addNoteAction = objc.action(move (): void => {
    const noteId = nextId;
    nextId = nextId + 1;
    store.add(Note({
      id: noteId,
      title: `Untitled ${noteId}`,
      body: "Created from the native AppKit action.",
    }));
    statusLabel.stringValue = `Added note ${noteId} — ${store.noteCount()} total`;
    window.title = `Z Notes — ${store.noteCount()} notes`;
    console.log(`added note ${noteId}, total=${store.noteCount()}`);
  });
  addButton.target = addNoteAction;
  addButton.action = addNoteAction.selector;
  content.addSubview(addButton);

  window.center();
  window.makeKeyAndOrderFront(null);

  app.activate();
  app.run();
  return 0;
}
