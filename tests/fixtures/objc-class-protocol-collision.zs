import AppKit from "AppKit/AppKit.h";
import { thread } from "std/thread";

function createMenuItem(): AppKit.NSMenuItem on thread.main {
  return AppKit.NSMenuItem.alloc().init();
}

function main(): i32 on thread.main {
  const item = createMenuItem();
  item.title = "File";
  return 0;
}
