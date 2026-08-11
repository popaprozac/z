import console from "std/console";
import sdl from "SDL3/SDL_init.h";
import events from "SDL3/SDL_events.h";
import mouse from "SDL3/SDL_mouse.h";
import render from "SDL3/SDL_render.h";
import video from "SDL3/SDL_video.h";
import timer from "SDL3/SDL_timer.h";

struct SDLRuntime {
    deinit {
        sdl.SDL_Quit();
    }
}

function main(): i32 {
    if (!sdl.SDL_Init(sdl.SDL_INIT_VIDEO)) {
        console.error(`SDL_Init failed: ${sdl.SDL_GetError()}`);
        return 1;
    }
    const runtime = SDLRuntime({});

    const window = video.SDL_CreateWindow(
        "Z + SDL3",
        800,
        450,
        0
    );

    if (window == null) {
        console.error(`SDL_CreateWindow failed: ${video.SDL_GetError()}`);
        return 1;
    }

    const renderer = render.SDL_CreateRenderer(window, null);
    if (renderer == null) {
        console.error(`SDL_CreateRenderer failed: ${render.SDL_GetError()}`);
        return 1;
    }

    console.log("SDL3 window opened successfully");

    const quitEvent = u32(events.SDL_EVENT_QUIT);
    const windowCloseRequested = u32(events.SDL_EVENT_WINDOW_CLOSE_REQUESTED);
    // SDL_BUTTON_LMASK is a function-like C macro, which the checked importer
    // does not yet expose.
    const leftMouseButtonMask: u32 = 1;
    let running = true;
    let event;
    while (running) {
        while (events.SDL_PollEvent(out event)) {
            const eventType = unsafe {
                select event.type;
            };
            if (
                eventType == quitEvent
                || eventType == windowCloseRequested
            ) running = false;
        }

        let mouseX;
        let mouseY;
        const mouseButtons = mouse.SDL_GetMouseState(out mouseX, out mouseY);
        const insideQuitButton = (
            mouseX >= 300.0
            && mouseX <= 500.0
            && mouseY >= 180.0
            && mouseY <= 270.0
        );

        if (
            insideQuitButton
            && (mouseButtons & leftMouseButtonMask) != 0
        ) {
            running = false;
        }

        render.SDL_SetRenderDrawColor(renderer, 24, 28, 36, 255);
        render.SDL_RenderClear(renderer);

        if (insideQuitButton) {
            render.SDL_SetRenderDrawColor(renderer, 230, 76, 86, 255);
        } else {
            render.SDL_SetRenderDrawColor(renderer, 196, 54, 64, 255);
        }

        let row: f32 = 180.0;
        while (row <= 270.0) {
            render.SDL_RenderLine(renderer, 300.0, row, 500.0, row);
            row = row + 1.0;
        }

        render.SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255);
        render.SDL_RenderDebugText(renderer, 384.0, 221.0, "QUIT");
        render.SDL_RenderPresent(renderer);
        timer.SDL_Delay(16);
    }
    return 0;
}
