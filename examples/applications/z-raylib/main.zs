import raylib from "raylib.h";

struct RaylibRuntime {
    deinit {
        raylib.CloseWindow();
    }
}

function main(): i32 {
    raylib.InitWindow(800, 450, "Z + raylib");
    if (!raylib.IsWindowReady()) return 1;

    const runtime = RaylibRuntime({});
    raylib.SetTargetFPS(60);

    const background = raylib.Color({
        r: 245,
        g: 245,
        b: 245,
        a: 255,
    });

    const textColor = raylib.Color({
        r: 0,
        g: 0,
        b: 0,
        a: 255,
    });

    const quitButton = raylib.Rectangle({
        x: 300.0,
        y: 180.0,
        width: 200.0,
        height: 90.0,
    });

    const buttonColor = raylib.Color({
        r: 196,
        g: 54,
        b: 64,
        a: 255,
    });

    const buttonHoverColor = raylib.Color({
        r: 230,
        g: 76,
        b: 86,
        a: 255,
    });

    const buttonTextColor = raylib.Color({
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    });

    const leftMouseButton = i32(raylib.MOUSE_BUTTON_LEFT);
    let running = true;
    while (running && !raylib.WindowShouldClose()) {
        const mousePosition = raylib.GetMousePosition();
        const insideQuitButton = raylib.CheckCollisionPointRec(
            mousePosition,
            quitButton
        );

        if (insideQuitButton && raylib.IsMouseButtonPressed(leftMouseButton)) {
            running = false;
        }

        raylib.BeginDrawing();
        raylib.ClearBackground(background);
        raylib.DrawText("Hello from Z + raylib", 268, 110, 24, textColor);
        raylib.DrawRectangleRec(
            quitButton,
            insideQuitButton ? buttonHoverColor : buttonColor
        );
        raylib.DrawText("QUIT", 370, 211, 28, buttonTextColor);
        raylib.EndDrawing();
    }
    return 0;
}
