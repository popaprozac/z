use std::ffi::CStr;
use std::marker::PhantomData;
use std::mem::MaybeUninit;
use std::ptr::{NonNull, null};

use sdl3_sys::error::SDL_GetError;
use sdl3_sys::events::{
    SDL_EVENT_QUIT, SDL_EVENT_WINDOW_CLOSE_REQUESTED, SDL_Event, SDL_PollEvent,
};
use sdl3_sys::init::{SDL_INIT_VIDEO, SDL_Init, SDL_Quit};
use sdl3_sys::mouse::SDL_GetMouseState;
use sdl3_sys::render::{
    SDL_CreateRenderer, SDL_DestroyRenderer, SDL_RenderClear, SDL_RenderDebugText, SDL_RenderLine,
    SDL_RenderPresent, SDL_Renderer, SDL_SetRenderDrawColor,
};
use sdl3_sys::timer::SDL_Delay;
use sdl3_sys::video::{SDL_CreateWindow, SDL_DestroyWindow, SDL_Window, SDL_WindowFlags};

fn sdl_error() -> String {
    unsafe {
        CStr::from_ptr(SDL_GetError())
            .to_string_lossy()
            .into_owned()
    }
}

struct SdlRuntime;

impl SdlRuntime {
    fn initialize() -> Result<Self, String> {
        if unsafe { SDL_Init(SDL_INIT_VIDEO) } {
            Ok(Self)
        } else {
            Err(format!("SDL_Init failed: {}", sdl_error()))
        }
    }
}

impl Drop for SdlRuntime {
    fn drop(&mut self) {
        unsafe { SDL_Quit() };
    }
}

struct Window(NonNull<SDL_Window>);

impl Window {
    fn create() -> Result<Self, String> {
        let raw =
            unsafe { SDL_CreateWindow(c"Rust + SDL3".as_ptr(), 800, 450, SDL_WindowFlags(0)) };
        NonNull::new(raw)
            .map(Self)
            .ok_or_else(|| format!("SDL_CreateWindow failed: {}", sdl_error()))
    }

    fn as_ptr(&self) -> *mut SDL_Window {
        self.0.as_ptr()
    }
}

impl Drop for Window {
    fn drop(&mut self) {
        unsafe { SDL_DestroyWindow(self.as_ptr()) };
    }
}

struct Renderer<'window> {
    raw: NonNull<SDL_Renderer>,
    _window: PhantomData<&'window Window>,
}

impl<'window> Renderer<'window> {
    fn create(window: &'window Window) -> Result<Self, String> {
        let raw = unsafe { SDL_CreateRenderer(window.as_ptr(), null()) };
        NonNull::new(raw)
            .map(|raw| Self {
                raw,
                _window: PhantomData,
            })
            .ok_or_else(|| format!("SDL_CreateRenderer failed: {}", sdl_error()))
    }

    fn as_ptr(&self) -> *mut SDL_Renderer {
        self.raw.as_ptr()
    }
}

impl Drop for Renderer<'_> {
    fn drop(&mut self) {
        unsafe { SDL_DestroyRenderer(self.as_ptr()) };
    }
}

fn run() -> Result<(), String> {
    let _runtime = SdlRuntime::initialize()?;
    let window = Window::create()?;
    let renderer = Renderer::create(&window)?;

    println!("SDL3 window opened successfully");

    const LEFT_MOUSE_BUTTON_MASK: u32 = 1;
    let mut running = true;
    let mut event = MaybeUninit::<SDL_Event>::uninit();
    while running {
        while unsafe { SDL_PollEvent(event.as_mut_ptr()) } {
            let event = unsafe { event.assume_init_ref() };
            let event_type = unsafe { event.r#type };
            if event_type == SDL_EVENT_QUIT {
                running = false;
            } else if event_type == SDL_EVENT_WINDOW_CLOSE_REQUESTED {
                let window_event = unsafe { event.window };
                println!("SDL window {} requested close", window_event.windowID.0);
                running = false;
            }
        }

        let mut mouse_x = MaybeUninit::<f32>::uninit();
        let mut mouse_y = MaybeUninit::<f32>::uninit();
        let mouse_buttons =
            unsafe { SDL_GetMouseState(mouse_x.as_mut_ptr(), mouse_y.as_mut_ptr()) };
        let mouse_x = unsafe { mouse_x.assume_init() };
        let mouse_y = unsafe { mouse_y.assume_init() };
        let inside_quit_button =
            (300.0..=500.0).contains(&mouse_x) && (180.0..=270.0).contains(&mouse_y);

        if inside_quit_button && (mouse_buttons.0 & LEFT_MOUSE_BUTTON_MASK) != 0 {
            running = false;
        }

        unsafe {
            SDL_SetRenderDrawColor(renderer.as_ptr(), 24, 28, 36, 255);
            SDL_RenderClear(renderer.as_ptr());

            if inside_quit_button {
                SDL_SetRenderDrawColor(renderer.as_ptr(), 230, 76, 86, 255);
            } else {
                SDL_SetRenderDrawColor(renderer.as_ptr(), 196, 54, 64, 255);
            }

            let mut row = 180.0;
            while row <= 270.0 {
                SDL_RenderLine(renderer.as_ptr(), 300.0, row, 500.0, row);
                row += 1.0;
            }

            SDL_SetRenderDrawColor(renderer.as_ptr(), 255, 255, 255, 255);
            SDL_RenderDebugText(renderer.as_ptr(), 384.0, 221.0, c"QUIT".as_ptr());
            SDL_RenderPresent(renderer.as_ptr());
            SDL_Delay(16);
        }
    }

    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
