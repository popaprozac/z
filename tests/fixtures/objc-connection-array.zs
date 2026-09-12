import AppKit from "AppKit/AppKit.h";
import objc from "std/objc";
import console from "std/console";
import { thread } from "std/thread";

class Owner on thread.main {
  deinit { console.log("released callback"); }
  function run(): void {}
}
function add(inout connections: Array<objc.Connection>): void on thread.main {
  const button = AppKit.NSButton.alloc().init();
  const owner = new Owner({});
  const connection = objc.connect(button, move (): void => owner.run());
  connections.push(connection);
}
function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  let connections = Array<objc.Connection>();
  let index = 0;
  while (index < 9) { add(inout connections); index = index + 1; }
  console.log("clearing");
  connections.clear();
  console.log("cleared");
  add(inout connections);
  console.log("leaving");
  return 0;
}
