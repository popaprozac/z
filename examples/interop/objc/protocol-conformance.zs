import AppKit from "AppKit/AppKit.h";
import objc from "std/objc";
import console from "std/console";

class TableController implements
  AppKit.NSTableViewDataSource,
  AppKit.NSTableViewDelegate
{
  function rowCount(
    in tableView: AppKit.NSTableView
  ): isize as "numberOfRowsInTableView:" {
    return 0;
  }

  function viewForRow(
    in tableView: AppKit.NSTableView,
    in tableColumn: AppKit.NSTableColumn | null,
    row: isize
  ): AppKit.NSView | null as "tableView:viewForTableColumn:row:" {
    return null;
  }
}

function main(): i32 {
  const controller = new TableController({});
  const tableView = AppKit.NSTableView.alloc().initWithFrame(
    AppKit.NSMakeRect(0.0, 0.0, 320.0, 240.0)
  );
  const tableBinding = objc.bind(tableView, {
    dataSource: controller,
    delegate: controller,
  });
  console.log(tableBinding);
  return 0;
}
