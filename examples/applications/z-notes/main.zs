import console from "std/console";
import objc from "std/objc";
import AppKit from "AppKit/AppKit.h";
import { Note, NoteStore } from "./model.zs";
import { insertNote, loadNotes, sqliteVersion } from "./persistence.zs";

function main(): i32 {
  const databasePath = ".z-cache/z-notes.sqlite3";
  const store = new NoteStore({
    notes: loadNotes(databasePath),
    selection: Option<usize>.none,
  });
  if (store.noteCount() > 0) store.selectNote(0);

  console.log(`sqlite=${sqliteVersion()}, database=${databasePath}, notes=${store.noteCount()}`);
  store.withSelected((in note) => {
    console.log(`selected note ${note.id}: ${note.title}`);
  });

  const app = AppKit.NSApplication.sharedApplication;
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

  const frame = AppKit.NSMakeRect(0.0, 0.0, 820.0, 640.0);
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
    AppKit.NSMakeRect(24.0, 580.0, 500.0, 32.0)
  );
  heading.stringValue = "Z Notes";
  heading.bezeled = false;
  heading.drawsBackground = false;
  heading.editable = false;
  heading.selectable = false;
  content.addSubview(heading);

  const selectedLabel = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 536.0, 620.0, 24.0)
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

  const titleField = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 488.0, 768.0, 28.0)
  );
  titleField.placeholderString = "Note title";
  content.addSubview(titleField);

  const bodyField = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 444.0, 768.0, 28.0)
  );
  bodyField.placeholderString = "Note body";
  content.addSubview(bodyField);

  const notesView = AppKit.NSTextView.alloc().initWithFrame(
    AppKit.NSMakeRect(0.0, 0.0, 744.0, 332.0)
  );
  notesView.editable = false;
  notesView.selectable = true;
  notesView.string = store.renderText();

  const notesScroll = AppKit.NSScrollView.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 76.0, 768.0, 344.0)
  );
  notesScroll.hasVerticalScroller = true;
  notesScroll.documentView = notesView;
  content.addSubview(notesScroll);

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

  let nextId = store.nextNoteId();
  const addNoteAction = objc.action(move (): void => {
    const noteId = nextId;
    const title = `${titleField.stringValue}`;
    const body = `${bodyField.stringValue}`;
    if (title.isEmpty) {
      statusLabel.stringValue = "Enter a title before saving";
      return;
    }
    const note = Note({ id: noteId, title, body });
    if (!insertNote(databasePath, note)) {
      statusLabel.stringValue = `Could not save note ${noteId}`;
      console.error(`could not save note ${noteId}`);
      return;
    }
    nextId = nextId + 1;
    selectedLabel.stringValue = `Selected: ${note.title}`;
    store.add(note);
    store.selectNote(store.noteCount() - 1);
    notesView.string = store.renderText();
    statusLabel.stringValue = `Added note ${noteId} — ${store.noteCount()} total`;
    window.title = `Z Notes — ${store.noteCount()} notes`;
    titleField.stringValue = "";
    bodyField.stringValue = "";
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
