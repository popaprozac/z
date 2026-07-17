import stdio from "stdio.h";

struct Point {
  x: i32;
  y: i32;

  function translated(dx: i32, dy: i32): Point {
    return Point({
      x: this.x + dx,
      y: this.y + dy,
    });
  }

  function sum(): i32 {
    return this.x + this.y;
  }
}

function main(): i32 {
  const original = Point({ x: 20, y: 22 });
  const copied = original;
  const translated = copied.translated(1, 2);

  stdio.printf("original=%d translated=%d\n", original.sum(), translated.sum());
  return 0;
}

