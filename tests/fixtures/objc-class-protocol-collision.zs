import AppKit from "AppKit/AppKit.h";
import { thread } from "std/thread";

struct MenuDefinition {
  title: String;
}

function createMenuItem(): AppKit.NSMenuItem on thread.main {
  return AppKit.NSMenuItem.alloc().init();
}

function main(): i32 on thread.main {
  const item = createMenuItem();
  const definition = MenuDefinition({ title: "File" });
  item.title = definition.title;
  return 0;
}
