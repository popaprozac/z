import AppKit from "AppKit/AppKit.h";
import QuartzCore from "QuartzCore/CADisplayLink.h";
import clock from "QuartzCore/CABase.h";
import WebKit from "WebKit/WebKit.h";
import objc from "std/objc";
import { thread } from "std/thread";

function interpolateFrame(start: AppKit.NSRect, target: AppKit.NSRect, progress: f64): AppKit.NSRect {
  if (progress <= 0) return start;
  if (progress >= 1) return target;
  const remaining = 1 - progress;
  const eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - 4 * remaining * remaining * remaining;
  return AppKit.NSMakeRect(
    start.origin.x + (target.origin.x - start.origin.x) * eased,
    start.origin.y + (target.origin.y - start.origin.y) * eased,
    start.size.width + (target.size.width - start.size.width) * eased,
    start.size.height + (target.size.height - start.size.height) * eased
  );
}

function invalidateDisplay(in link: QuartzCore.CADisplayLink | null): void on thread.main {
  if (link != null) link.invalidate();
}

function equalFrames(left: AppKit.NSRect, right: AppKit.NSRect): boolean {
  return left.origin.x == right.origin.x && left.origin.y == right.origin.y
    && left.size.width == right.size.width && left.size.height == right.size.height;
}

function equalSizes(left: AppKit.NSRect, right: AppKit.NSRect): boolean {
  return left.size.width == right.size.width && left.size.height == right.size.height;
}

function createDisplay(in window: SmoothWindow): QuartzCore.CADisplayLink on thread.main {
  const link = window.displayLinkWithTarget(window, selector: objc.selector(SmoothWindow.onDisplay));
  const screen = window.screen;
  if (screen != null) {
    const maximum = f32(screen.maximumFramesPerSecond);
    if (maximum > 0) {
      link.preferredFrameRateRange = QuartzCore.CAFrameRateRangeMake(maximum < 60 ? maximum : f32(60), maximum, maximum);
    }
  }
  link.addToRunLoop(AppKit.NSRunLoop.mainRunLoop, forMode: AppKit.NSRunLoopCommonModes);
  return link;
}

// An integration probe, not yet Zapp's production window implementation.
class SmoothWindow extends AppKit.NSWindow on thread.main {
  private displayLink: QuartzCore.CADisplayLink | null;
  private startFrame: AppKit.NSRect;
  private targetFrame: AppKit.NSRect;
  private restoreFrame: AppKit.NSRect;
  private hasRestoreFrame: boolean;
  private preparingZoom: boolean;
  private applyingFrame: boolean;
  private zoomTransition: boolean;
  private targetIsZoomed: boolean;
  private updateRestoreOnCompletion: boolean;
  private startedAt: f64;
  private duration: f64;
  private animating: boolean;
  private shuttingDown: boolean;
  private needsDisplay: boolean;
  private callbacks: i32;

  constructor(frame: AppKit.NSRect) {
    super.initWithContentRect(frame,
      styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskClosable | AppKit.NSWindowStyleMaskResizable,
      backing: AppKit.NSBackingStoreBuffered, defer: false);
    this.displayLink = null;
    this.startFrame = frame;
    this.targetFrame = frame;
    this.restoreFrame = frame;
    this.hasRestoreFrame = false;
    this.preparingZoom = false;
    this.applyingFrame = false;
    this.zoomTransition = false;
    this.targetIsZoomed = false;
    this.updateRestoreOnCompletion = false;
    this.startedAt = 0;
    this.duration = 0;
    this.animating = false;
    this.shuttingDown = false;
    this.needsDisplay = true;
    this.callbacks = 0;
    this.releasedWhenClosed = false;
  }

  override function isZoomed(): boolean as "isZoomed" {
    if (this.animating && this.zoomTransition) return this.targetIsZoomed;
    return super.isZoomed();
  }

  override function animationResizeTime(frame: AppKit.NSRect): f64 as "animationResizeTime:" {
    if (this.preparingZoom) return 0;
    return super.animationResizeTime(frame);
  }

  override function resize(inout this, frame: AppKit.NSRect, display: boolean, animate: boolean): void as "setFrame:display:animate:" {
    if (this.preparingZoom || this.applyingFrame) {
      super.setFrame(frame, display: display, animate: false);
      return;
    }
    // Replacing a transition always disconnects its old tick source first.
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    this.animating = false;
    this.zoomTransition = false;
    const start = this.frame;
    const wasZoomed = super.isZoomed();
    const updateRestore = this.hasRestoreFrame && !wasZoomed && !equalSizes(start, frame);
    const duration = super.animationResizeTime(frame);
    const screen = this.screen;
    if (!animate || this.shuttingDown || AppKit.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion || duration <= 0 || screen == null || equalFrames(start, frame)) {
      this.applyingFrame = true;
      super.setFrame(frame, display: display);
      this.applyingFrame = false;
      if (updateRestore) this.restoreFrame = this.frame;
      return;
    }
    this.startFrame = start;
    this.targetFrame = frame;
    this.duration = duration;
    this.startedAt = clock.CACurrentMediaTime();
    this.needsDisplay = display;
    this.updateRestoreOnCompletion = updateRestore;
    this.animating = true;
    this.displayLink = createDisplay(this);
  }

  override function setFrame(inout this, frame: AppKit.NSRect, display: boolean): void as "setFrame:display:" {
    if (this.preparingZoom || this.applyingFrame) {
      super.setFrame(frame, display: display);
      return;
    }
    this.animating = false;
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    const start = this.frame;
    const wasZoomed = super.isZoomed();
    const updateRestore = this.hasRestoreFrame && !wasZoomed && !equalSizes(start, frame);
    super.setFrame(frame, display: display);
    if (updateRestore) this.restoreFrame = this.frame;
  }

  override function zoom(inout this, in sender: objc.Object | null): void as "zoom:" {
    const start = this.frame;
    const interrupted = this.animating;
    const previousTarget = this.targetFrame;
    this.animating = false;
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    if (interrupted) {
      this.applyingFrame = true;
      super.setFrame(previousTarget, display: false);
      this.applyingFrame = false;
    }
    // Let AppKit commit its standard/user-frame state before reading the
    // intended target. Our nested overrides suppress only that preparation's
    // animation; normal delegates and native constraints still run.
    this.preparingZoom = true;
    super.zoom(sender);
    this.preparingZoom = false;
    let target = this.frame;
    let targetZoomed = super.isZoomed();
    // An unchanged target can be a delegate veto. Never manufacture a restore
    // transition after AppKit declined the operation.
    if (equalFrames(start, target)) return;
    if (targetZoomed) {
      if (!this.hasRestoreFrame) {
        this.restoreFrame = start;
        this.hasRestoreFrame = true;
      }
    } else if (this.hasRestoreFrame) target = this.restoreFrame;

    const screen = this.screen;
    if (this.shuttingDown || AppKit.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion || screen == null) {
      this.applyingFrame = true;
      super.setFrame(target, display: true);
      this.applyingFrame = false;
      if (!targetZoomed) this.hasRestoreFrame = false;
      return;
    }
    this.applyingFrame = true;
    super.setFrame(start, display: true);
    this.applyingFrame = false;
    // AppKit computes duration from the current frame to the requested frame.
    // Asking while still at the prepared target can yield a zero duration.
    const duration = super.animationResizeTime(target);
    if (duration <= 0) {
      this.applyingFrame = true;
      super.setFrame(target, display: true);
      this.applyingFrame = false;
      if (!targetZoomed) this.hasRestoreFrame = false;
      return;
    }
    this.startFrame = start;
    this.targetFrame = target;
    this.duration = duration;
    this.startedAt = clock.CACurrentMediaTime();
    this.needsDisplay = true;
    this.zoomTransition = true;
    this.targetIsZoomed = targetZoomed;
    this.updateRestoreOnCompletion = false;
    this.animating = true;
    this.displayLink = createDisplay(this);
  }

  function onDisplay(inout this, in link: QuartzCore.CADisplayLink): void as "display:" {
    // Count every delivered callback so shutdown tests detect a live source,
    // even when the controller ignores the callback after invalidation.
    this.callbacks = this.callbacks + 1;
    const active = this.displayLink;
    // A queued callback from an invalidated source must not advance a newer
    // animation. This compares object identity, without invoking isEqual:.
    if (active == null || link != active) {
      link.invalidate();
      return;
    }
    if (!this.animating || this.shuttingDown) return;
    const reducedMotion = AppKit.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    const progress = reducedMotion ? 1.0 : (link.targetTimestamp - this.startedAt) / this.duration;
    const frame = interpolateFrame(this.startFrame, this.targetFrame, progress);
    if (progress >= 1) {
      this.animating = false;
      invalidateDisplay(this.displayLink);
      this.displayLink = null;
      if (this.zoomTransition && !this.targetIsZoomed) this.hasRestoreFrame = false;
    }
    const display = this.needsDisplay;
    this.applyingFrame = true;
    super.setFrame(frame, display: display);
    this.applyingFrame = false;
    if (progress >= 1 && this.updateRestoreOnCompletion) this.restoreFrame = this.frame;
  }

  override function close(inout this): void as "close" {
    this.shuttingDown = true;
    this.animating = false;
    invalidateDisplay(this.displayLink);
    this.displayLink = null;
    super.close();
  }

  function isAnimating(): boolean as "zResizeIsAnimating" { return this.animating; }
  function displayCallbacks(): i32 as "zResizeDisplayCallbacks" { return this.callbacks; }
}

function main(): i32 {
  const app = AppKit.NSApplication.sharedApplication;
  app.setActivationPolicy(AppKit.NSApplicationActivationPolicyRegular);
  const window = new SmoothWindow(AppKit.NSMakeRect(100, 100, 640, 440));
  window.title = "Z display-link resize probe";
  // This probe covers zoom, not system-owned fullscreen transitions.
  window.collectionBehavior = AppKit.NSWindowCollectionBehaviorFullScreenNone;
  const configuration = WebKit.WKWebViewConfiguration.new();
  configuration.websiteDataStore = WebKit.WKWebsiteDataStore.nonPersistentDataStore();
  const webview = WebKit.WKWebView.alloc().initWithFrame(WebKit.CGRectMake(0, 0, 640, 440), configuration: configuration);
  window.contentView = webview;
  webview.loadHTMLString("<!doctype html><style>html{background:#15212b;color:#eef;font:18px system-ui}body{padding:20px}#grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}.card{background:#2c4a60;padding:20px}#edge{position:fixed;bottom:0;right:0;background:#baeeae;color:#14251d;padding:12px}</style><h1>Display-driven resizing in Z</h1><p>Use the green zoom button. Try clicking again mid-transition.</p><p id='size'></p><div id='grid'></div><div id='edge'>Bottom right</div><script>document.getElementById('grid').innerHTML=Array.from({length:18},(_,i)=>'<div class=card>Note '+(i+1)+'</div>').join('');function tick(){document.getElementById('size').textContent=innerWidth+' x '+innerHeight;requestAnimationFrame(tick)}tick()</script>", baseURL: null);
  window.makeKeyAndOrderFront(null);
  const center = AppKit.NSNotificationCenter.defaultCenter;
  const closeObserver = center.addObserverForName(
    AppKit.NSWindowWillCloseNotification,
    object: window,
    queue: null,
    usingBlock: move (notification): void => {
      app.stop(null);
      const emptyModifiers = AppKit.NSEventModifierFlagCapsLock ^ AppKit.NSEventModifierFlagCapsLock;
      const wakeEvent = AppKit.NSEvent.otherEventWithType(
        AppKit.NSEventTypeApplicationDefined,
        location: AppKit.NSMakePoint(0, 0), modifierFlags: emptyModifiers,
        timestamp: 0, windowNumber: 0, context: null, subtype: 0, data1: 0, data2: 0
      );
      if (wakeEvent != null) app.postEvent(wakeEvent, atStart: true);
    }
  );
  app.activate();
  // AppKit must dispatch events, not merely service Foundation run-loop sources.
  // The retained observer stops and wakes this loop when the window closes.
  app.run();
  center.removeObserver(closeObserver);
  return 0;
}
