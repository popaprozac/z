import console from "std/console";
import objc from "std/objc";
import AppKit from "AppKit/AppKit.h";

class ActionState {
  value: i32;
}

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  const state = new ActionState({ value: 42 });
  const button = AppKit.NSButton.alloc().init();
  const action = objc.action(move () => {
    console.log(`button action value=${state.value}`);
  });

  button.target = action;
  button.action = action.selector;
  app.finishLaunching();
  button.performClick(null);
  return 0;
}
