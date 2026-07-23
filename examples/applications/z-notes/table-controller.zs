import AppKit from "AppKit/AppKit.h";
import { NoteStore } from "./model.zs";

export class NotesTableController implements
  AppKit.NSTableViewDataSource,
  AppKit.NSTableViewDelegate
{
  private store: NoteStore;
  private tableView: AppKit.NSTableView;
  private selectedLabel: AppKit.NSTextField;

  constructor(
    store: NoteStore,
    tableView: AppKit.NSTableView,
    selectedLabel: AppKit.NSTextField
  ) {
    this.store = store;
    this.tableView = tableView;
    this.selectedLabel = selectedLabel;
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

  function selectionDidChange(
    inout this,
    in notification: AppKit.NSNotification
  ): void as "tableViewSelectionDidChange:" {
    const row = this.tableView.selectedRow;
    if (row < 0) {
      this.store.clearSelection();
      this.selectedLabel.stringValue = "No note selected";
      return;
    }
    if (!this.store.selectNote(usize(row))) {
      this.selectedLabel.stringValue = "No note selected";
      return;
    }
    const label = this.selectedLabel;
    this.store.withSelected((in note) => {
      label.stringValue = `Selected: ${note.title}`;
    });
  }
}
