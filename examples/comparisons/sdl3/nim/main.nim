const sdlHeader = "<SDL3/SDL.h>"

type
  SDLWindow {.importc: "SDL_Window", header: sdlHeader, incompleteStruct.} = object
  SDLRenderer {.importc: "SDL_Renderer", header: sdlHeader, incompleteStruct.} = object

  SDLWindowEvent {.importc: "SDL_WindowEvent", header: sdlHeader, bycopy.} = object
    kind {.importc: "type".}: uint32
    reserved: uint32
    timestamp: uint64
    windowID: uint32
    data1: int32
    data2: int32

  SDLEvent {.importc: "SDL_Event", header: sdlHeader, bycopy, union.} = object
    kind {.importc: "type".}: uint32
    window: SDLWindowEvent

var
  SDL_INIT_VIDEO {.importc, header: sdlHeader.}: uint32
  SDL_EVENT_QUIT {.importc, header: sdlHeader.}: uint32
  SDL_EVENT_WINDOW_CLOSE_REQUESTED {.importc, header: sdlHeader.}: uint32

proc SDL_Init(flags: uint32): bool {.importc, header: sdlHeader.}
proc SDL_Quit() {.importc, header: sdlHeader.}
proc SDL_GetError(): cstring {.importc, header: sdlHeader.}
proc SDL_CreateWindow(
  title: cstring,
  width: cint,
  height: cint,
  flags: uint64
): ptr SDLWindow {.importc, header: sdlHeader.}
proc SDL_DestroyWindow(window: ptr SDLWindow) {.importc, header: sdlHeader.}
proc SDL_CreateRenderer(
  window: ptr SDLWindow,
  name: cstring
): ptr SDLRenderer {.importc, header: sdlHeader.}
proc SDL_DestroyRenderer(renderer: ptr SDLRenderer) {.importc, header: sdlHeader.}
proc SDL_PollEvent(event: ptr SDLEvent): bool {.importc, header: sdlHeader.}
proc SDL_GetMouseState(x: ptr cfloat, y: ptr cfloat): uint32 {.
  importc, header: sdlHeader.}
proc SDL_SetRenderDrawColor(
  renderer: ptr SDLRenderer,
  red: uint8,
  green: uint8,
  blue: uint8,
  alpha: uint8
): bool {.importc, header: sdlHeader.}
proc SDL_RenderClear(renderer: ptr SDLRenderer): bool {.
  importc, header: sdlHeader.}
proc SDL_RenderLine(
  renderer: ptr SDLRenderer,
  x1: cfloat,
  y1: cfloat,
  x2: cfloat,
  y2: cfloat
): bool {.importc, header: sdlHeader.}
proc SDL_RenderDebugText(
  renderer: ptr SDLRenderer,
  x: cfloat,
  y: cfloat,
  text: cstring
): bool {.importc, header: sdlHeader.}
proc SDL_RenderPresent(renderer: ptr SDLRenderer): bool {.
  importc, header: sdlHeader.}
proc SDL_Delay(milliseconds: uint32) {.importc, header: sdlHeader.}

proc run(): int =
  if not SDL_Init(SDL_INIT_VIDEO):
    stderr.writeLine("SDL_Init failed: " & $SDL_GetError())
    return 1
  defer: SDL_Quit()

  let window = SDL_CreateWindow("Nim + SDL3", 800, 450, 0)
  if window.isNil:
    stderr.writeLine("SDL_CreateWindow failed: " & $SDL_GetError())
    return 1
  defer: SDL_DestroyWindow(window)

  let renderer = SDL_CreateRenderer(window, nil)
  if renderer.isNil:
    stderr.writeLine("SDL_CreateRenderer failed: " & $SDL_GetError())
    return 1
  defer: SDL_DestroyRenderer(renderer)

  echo "SDL3 window opened successfully"

  const leftMouseButtonMask = 1'u32
  var running = true
  var event: SDLEvent
  while running:
    while SDL_PollEvent(addr event):
      if event.kind == SDL_EVENT_QUIT:
        running = false
      elif event.kind == SDL_EVENT_WINDOW_CLOSE_REQUESTED:
        echo "SDL window ", event.window.windowID, " requested close"
        running = false

    var mouseX: cfloat
    var mouseY: cfloat
    let mouseButtons = SDL_GetMouseState(addr mouseX, addr mouseY)
    let insideQuitButton =
      mouseX >= 300.0 and mouseX <= 500.0 and
      mouseY >= 180.0 and mouseY <= 270.0

    if insideQuitButton and (mouseButtons and leftMouseButtonMask) != 0:
      running = false

    discard SDL_SetRenderDrawColor(renderer, 24, 28, 36, 255)
    discard SDL_RenderClear(renderer)

    if insideQuitButton:
      discard SDL_SetRenderDrawColor(renderer, 230, 76, 86, 255)
    else:
      discard SDL_SetRenderDrawColor(renderer, 196, 54, 64, 255)

    var row = 180.0'f32
    while row <= 270.0:
      discard SDL_RenderLine(renderer, 300.0, row, 500.0, row)
      row += 1.0

    discard SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255)
    discard SDL_RenderDebugText(renderer, 384.0, 221.0, "QUIT")
    discard SDL_RenderPresent(renderer)
    SDL_Delay(16)

  return 0

quit(run())
