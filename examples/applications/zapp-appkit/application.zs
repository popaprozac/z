import AppKit from "AppKit/AppKit.h";
import console from "std/console";
import objc from "std/objc";
import { Mutex, Once, OnceLifetime } from "std/sync";
import { thread } from "std/thread";

export struct RuntimeState {
  started: i32;
  completed: i32;
  routedAction: i32;
}

// This class deliberately mixes synchronized model state with real AppKit
// identity. Only the UI-facing members require the main executor.
export class Application {
  readonly name: String;
  readonly state: Mutex<RuntimeState>;
  window: AppKit.NSWindow on thread.main;
  statusLabel: AppKit.NSTextField on thread.main;
  actionButton: AppKit.NSButton on thread.main;
  actionConnection: objc.Connection on thread.main;

  function beginWork(): i32 {
    return this.state.withLock((inout state): i32 => {
      state.started = state.started + 1;
      return state.started;
    });
  }

  function finishWork(ticket: i32): void {
    this.state.withLock((inout state): void => {
      state.completed = ticket;
    });
  }

  function completedWork(): i32 {
    return this.state.withLock(
      (in state): i32 => state.completed
    );
  }

  function recordAction(ticket: i32): void {
    this.state.withLock((inout state): void => {
      state.routedAction = ticket;
    });
  }

  function routedAction(): i32 {
    return this.state.withLock(
      (in state): i32 => state.routedAction
    );
  }

  function show(): void on thread.main {
    this.window.center();
    this.window.makeKeyAndOrderFront(null);
  }

  function triggerAction(): void on thread.main {
    this.actionButton.performClick(null);
  }

  function publish(ticket: i32): void on thread.main {
    const status = `Ready after background job ${ticket}`;
    this.window.title = `${this.name} — ${status}`;
    this.statusLabel.stringValue = status;
    console.log(`published AppKit job ${ticket} on main`);
  }

  function close(): void on thread.main {
    this.window.close();
  }
}

const application = Once<Application>();

export function initializeApplication(
  value: Application
): OnceLifetime<Application> on thread.main {
  return application.initialize(move value);
}

export function currentApplication(): Application {
  return application.get();
}

export function publishApplicationStatus(
  ticket: i32
): void on thread.main {
  const current = currentApplication();
  current.publish(ticket);
}

export function closeApplication(): void on thread.main {
  const current = currentApplication();
  console.log("closing AppKit window on main");
  current.close();
}
