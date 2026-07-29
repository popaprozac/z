function double(value: i32): i32 {
  return value * 2;
}

c struct ZMathPoint {
  x: i32;
  y: i32;
}

export c function z_math_add(left: i32, right: i32): i32 {
  return left + right;
}

export c function z_math_answer(): i32 {
  return z_math_add(double(10), 22);
}

export c function z_math_is_even(value: i32): boolean {
  return value % 2 == 0;
}

export c function z_math_translate(
  point: ZMathPoint,
  dx: i32,
  dy: i32
): ZMathPoint {
  return ZMathPoint({
    x: point.x + dx,
    y: point.y + dy,
  });
}
