function double(value: i32): i32 {
  return value * 2;
}

c struct ZMathPoint {
  x: i32;
  y: i32;
}

c enum ZMathStatus: i32 {
  negative,
  zero,
  positive,
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

export c function z_math_classify(value: i32): ZMathStatus {
  if (value < 0) return ZMathStatus.negative;
  if (value == 0) return ZMathStatus.zero;
  return ZMathStatus.positive;
}

export c function z_math_status_code(status: ZMathStatus): i32 {
  return match (status) {
    negative => -1;
    zero => 0;
    positive => 1;
  };
}
