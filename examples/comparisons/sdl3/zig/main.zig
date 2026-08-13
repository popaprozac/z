const std = @import("std");

const sdl = @cImport({
    @cInclude("SDL3/SDL.h");
});

fn sdlError() []const u8 {
    return std.mem.span(sdl.SDL_GetError());
}

pub fn main() !void {
    if (!sdl.SDL_Init(sdl.SDL_INIT_VIDEO)) {
        std.debug.print("SDL_Init failed: {s}\n", .{sdlError()});
        return error.SDLInitializationFailed;
    }
    defer sdl.SDL_Quit();

    const window = sdl.SDL_CreateWindow("Zig + SDL3", 800, 450, 0) orelse {
        std.debug.print("SDL_CreateWindow failed: {s}\n", .{sdlError()});
        return error.SDLWindowCreationFailed;
    };
    defer sdl.SDL_DestroyWindow(window);

    const renderer = sdl.SDL_CreateRenderer(window, null) orelse {
        std.debug.print("SDL_CreateRenderer failed: {s}\n", .{sdlError()});
        return error.SDLRendererCreationFailed;
    };
    defer sdl.SDL_DestroyRenderer(renderer);

    std.debug.print("SDL3 window opened successfully\n", .{});

    const left_mouse_button_mask: u32 = 1;
    var running = true;
    var event: sdl.SDL_Event = undefined;
    while (running) {
        while (sdl.SDL_PollEvent(&event)) {
            const event_type = @field(event, "type");
            if (event_type == sdl.SDL_EVENT_QUIT) {
                running = false;
            } else if (event_type == sdl.SDL_EVENT_WINDOW_CLOSE_REQUESTED) {
                std.debug.print(
                    "SDL window {d} requested close\n",
                    .{event.window.windowID},
                );
                running = false;
            }
        }

        var mouse_x: f32 = undefined;
        var mouse_y: f32 = undefined;
        const mouse_buttons = sdl.SDL_GetMouseState(&mouse_x, &mouse_y);
        const inside_quit_button =
            mouse_x >= 300.0 and mouse_x <= 500.0 and
            mouse_y >= 180.0 and mouse_y <= 270.0;

        if (inside_quit_button and
            (mouse_buttons & left_mouse_button_mask) != 0)
        {
            running = false;
        }

        _ = sdl.SDL_SetRenderDrawColor(renderer, 24, 28, 36, 255);
        _ = sdl.SDL_RenderClear(renderer);

        if (inside_quit_button) {
            _ = sdl.SDL_SetRenderDrawColor(renderer, 230, 76, 86, 255);
        } else {
            _ = sdl.SDL_SetRenderDrawColor(renderer, 196, 54, 64, 255);
        }

        var row: f32 = 180.0;
        while (row <= 270.0) : (row += 1.0) {
            _ = sdl.SDL_RenderLine(renderer, 300.0, row, 500.0, row);
        }

        _ = sdl.SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255);
        _ = sdl.SDL_RenderDebugText(renderer, 384.0, 221.0, "QUIT");
        _ = sdl.SDL_RenderPresent(renderer);
        sdl.SDL_Delay(16);
    }
}
