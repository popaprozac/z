import console from "std/console";
import objc from "std/objc";
import { thread } from "std/thread";
import { delay } from "std/time";
import AppKit from "AppKit/AppKit.h";
import { Note, NoteStore } from "./model.zs";
import { NoteDatabase, loadNotesFromPath, sqliteVersion } from "./persistence.zs";
import { NotesTableController } from "./table-controller.zs";

function openNoteDatabase(in path: String): NoteDatabase throws i32 {
  return try new NoteDatabase(path);
}

function createNoteStore(): NoteStore {
  return new NoteStore({
    notes: Array<Note>(),
    selection: Option<usize>.none,
  });
}

function createTableController(
  store: NoteStore,
  tableView: AppKit.NSTableView,
  selectedLabel: AppKit.NSTextField
): NotesTableController {
  return new NotesTableController(store, tableView, selectedLabel);
}

function bindNotesTable(
  notesView: AppKit.NSTableView,
  tableController: NotesTableController
): objc.Binding {
  return objc.bind(notesView, {
    dataSource: tableController,
    delegate: tableController,
  });
}

function currentApplication(): AppKit.NSApplication {
  return AppKit.NSApplication.sharedApplication;
}

function createWindow(): AppKit.NSWindow {
  const frame = AppKit.NSMakeRect(0.0, 0.0, 820.0, 640.0);
  const style = AppKit.NSWindowStyleMaskTitled
    | AppKit.NSWindowStyleMaskClosable
    | AppKit.NSWindowStyleMaskMiniaturizable
    | AppKit.NSWindowStyleMaskResizable;
  return AppKit.NSWindow.alloc().initWithContentRect(
    frame,
    styleMask: style,
    backing: AppKit.NSBackingStoreBuffered,
    defer: false
  );
}

function runApplication(
  database: NoteDatabase,
  store: NoteStore,
  in databasePath: String,
  loadFailure: Option<i32>
): i32 {
  const app = currentApplication();
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);

  const window = createWindow();
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

  const notesView = AppKit.NSTableView.alloc().initWithFrame(
    AppKit.NSMakeRect(0.0, 0.0, 744.0, 332.0)
  );
  const notesColumn = AppKit.NSTableColumn.alloc().initWithIdentifier("notes");
  notesColumn.title = "Notes";
  notesColumn.width = 720.0;
  notesView.addTableColumn(notesColumn);
  notesView.rowHeight = 44.0;
  const tableController = createTableController(store, notesView, selectedLabel);
  const tableBinding = bindNotesTable(notesView, tableController);

  const notesScroll = AppKit.NSScrollView.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 76.0, 768.0, 344.0)
  );
  notesScroll.hasVerticalScroller = true;
  notesScroll.documentView = notesView;
  content.addSubview(notesScroll);

  const statusLabel = AppKit.NSTextField.alloc().initWithFrame(
    AppKit.NSMakeRect(24.0, 24.0, 620.0, 24.0)
  );
  statusLabel.stringValue = "Loading notes…";
  statusLabel.bezeled = false;
  statusLabel.drawsBackground = false;
  statusLabel.editable = false;
  statusLabel.selectable = false;
  content.addSubview(statusLabel);
  match (in loadFailure) {
    some(status) => {
      window.title = "Z Notes — Load failed";
      statusLabel.stringValue = `Could not load notes — sqlite status ${status}`;
    }
    none => {
      notesView.reloadData();
      statusLabel.stringValue = `Ready — ${store.noteCount()} notes`;
      console.log(`sqlite=${sqliteVersion()}, database=${databasePath}, notes=${store.noteCount()}`);
    }
  }

  const addButton = AppKit.NSButton.alloc().initWithFrame(
    AppKit.NSMakeRect(680.0, 20.0, 112.0, 32.0)
  );
  addButton.title = "Add Note";

  let nextId = store.nextNoteId();
  const addNoteConnection = objc.connect(addButton, move (): void => {
    const noteId = nextId;
    const title = `${titleField.stringValue}`;
    const body = `${bodyField.stringValue}`;
    if (title.isEmpty) {
      statusLabel.stringValue = "Enter a title before saving";
      return;
    }
    const note = Note({ id: noteId, title, body });
    const inserted = attempt database.insertNote(note);
    match (inserted) {
      success => {
        nextId = nextId + 1;
        selectedLabel.stringValue = `Selected: ${note.title}`;
        store.add(note);
        store.selectNote(store.noteCount() - 1);
        notesView.reloadData();
        statusLabel.stringValue = `Added note ${noteId} — ${store.noteCount()} total`;
        window.title = `Z Notes — ${store.noteCount()} notes`;
        titleField.stringValue = "";
        bodyField.stringValue = "";
        console.log(`added note ${noteId}, total=${store.noteCount()}`);
      }
      failure(status) => {
        statusLabel.stringValue = `Could not save note ${noteId}`;
        console.error(`could not save note ${noteId}: sqlite status ${status}`);
      }
    }
  });
  content.addSubview(addButton);

  window.center();
  window.makeKeyAndOrderFront(null);

  app.activate();
  app.run();
  return 0;
}

async function main(): i32 {
  const databasePath: String = ".z-cache/z-notes.sqlite3";
  const openedDatabase = attempt openNoteDatabase(databasePath);
  const database = match (openedDatabase) {
    success(database) => database;
    failure(status) => {
      console.error(`could not open notes database: sqlite status ${status}`);
      return status;
    }
  };

  const backgroundPath = copy databasePath;
  const loadTask = thread.spawn(async move (): Array<Note> throws i32 => {
    await delay(1);
    return try loadNotesFromPath(backgroundPath);
  });

  const store = createNoteStore();
  let loadFailure = Option<i32>.none;
  const loaded = attempt await loadTask;
  match (loaded) {
    success(notes) => {
      store.replace(move notes);
      if (store.noteCount() > 0) store.selectNote(0);
    }
    failure(status) => {
      loadFailure = Option.some(status);
      console.error(`could not load notes: sqlite status ${status}`);
    }
  }

  return await on thread.main: i32 {
    select runApplication(database, store, databasePath, loadFailure);
  };
}
