import AppKit from "AppKit/AppKit.h";
import { NoteStore } from "./model.zs";

export class NotesTableController implements
  AppKit.NSTableViewDataSource,
  AppKit.NSTableViewDelegate
{
  private store: NoteStore;

  constructor(store: NoteStore) {
    this.store = store;
  }

  function rowCount(
    in tableView: AppKit.NSTableView
  ): isize as "numberOfRowsInTableView:" {
    return this.store.tableRowCount();
  }

  function viewForRow(
    in tableView: AppKit.NSTableView,
    in tableColumn: AppKit.NSTableColumn | null,
    row: isize
  ): AppKit.NSView | null as "tableView:viewForTableColumn:row:" {
    const label = AppKit.NSTextField.alloc().initWithFrame(
      AppKit.NSMakeRect(0.0, 0.0, 720.0, 44.0)
    );
    label.bezeled = false;
    label.drawsBackground = false;
    label.editable = false;
    label.selectable = true;
    const found = this.store.withRow(row, (in note) => {
      label.stringValue = `${note.title} — ${note.body}`;
    });
    if (!found) label.stringValue = "Missing note";
    return label;
  }
}
