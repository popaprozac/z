struct InvalidRange {
  code: i32;
}

struct Range {
  minimum: i32;
  maximum: i32;

  static function normalized(left: i32, right: i32): Range {
    if (left <= right) {
      return Range({ minimum: left, maximum: right });
    }
    return Range({ minimum: right, maximum: left });
  }

  static function checked(left: i32, right: i32): Range throws InvalidRange {
    if (left == right) {
      throw InvalidRange({ code: left });
    }
    return Range.normalized(left, right);
  }

  function width(): i32 {
    return this.maximum - this.minimum;
  }
}

class NumberPolicy {
  static function clamp(value: i32, minimum: i32, maximum: i32): i32 {
    if (value < minimum) return minimum;
    if (value > maximum) return maximum;
    return value;
  }
}

function main(): i32 {
  const normalized = Range.normalized(9, 2);
  const checked = attempt Range.checked(20, 22);
  const checkedWidth = match (checked) {
    success(value) => value.width();
    failure(error) => error.code;
  };
  const clamped = NumberPolicy.clamp(50, 0, 10);
  return normalized.width() + checkedWidth + clamped - 19;
}
