#include <SDL3/SDL.h>

#include <stdbool.h>
#include <stdio.h>

int main(void) {
    bool initialized = false;
    SDL_Window *window = NULL;
    SDL_Renderer *renderer = NULL;
    int exit_code = 1;

    if (!SDL_Init(SDL_INIT_VIDEO)) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        goto cleanup;
    }
    initialized = true;

    window = SDL_CreateWindow("C + SDL3", 800, 450, 0);
    if (window == NULL) {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        goto cleanup;
    }

    renderer = SDL_CreateRenderer(window, NULL);
    if (renderer == NULL) {
        fprintf(stderr, "SDL_CreateRenderer failed: %s\n", SDL_GetError());
        goto cleanup;
    }

    puts("SDL3 window opened successfully");

    const Uint32 left_mouse_button_mask = 1;
    bool running = true;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            switch (event.type) {
                case SDL_EVENT_QUIT:
                    running = false;
                    break;
                case SDL_EVENT_WINDOW_CLOSE_REQUESTED:
                    printf(
                        "SDL window %u requested close\n",
                        event.window.windowID
                    );
                    running = false;
                    break;
                default:
                    break;
            }
        }

        float mouse_x;
        float mouse_y;
        const SDL_MouseButtonFlags mouse_buttons =
            SDL_GetMouseState(&mouse_x, &mouse_y);
        const bool inside_quit_button =
            mouse_x >= 300.0f && mouse_x <= 500.0f &&
            mouse_y >= 180.0f && mouse_y <= 270.0f;

        if (inside_quit_button &&
            (mouse_buttons & left_mouse_button_mask) != 0) {
            running = false;
        }

        (void)SDL_SetRenderDrawColor(renderer, 24, 28, 36, 255);
        (void)SDL_RenderClear(renderer);

        if (inside_quit_button) {
            (void)SDL_SetRenderDrawColor(renderer, 230, 76, 86, 255);
        } else {
            (void)SDL_SetRenderDrawColor(renderer, 196, 54, 64, 255);
        }

        for (float row = 180.0f; row <= 270.0f; row += 1.0f) {
            (void)SDL_RenderLine(renderer, 300.0f, row, 500.0f, row);
        }

        (void)SDL_SetRenderDrawColor(renderer, 255, 255, 255, 255);
        (void)SDL_RenderDebugText(renderer, 384.0f, 221.0f, "QUIT");
        (void)SDL_RenderPresent(renderer);
        SDL_Delay(16);
    }

    exit_code = 0;

cleanup:
    if (renderer != NULL) {
        SDL_DestroyRenderer(renderer);
    }
    if (window != NULL) {
        SDL_DestroyWindow(window);
    }
    if (initialized) {
        SDL_Quit();
    }
    return exit_code;
}
