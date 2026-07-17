import stdio from "stdio.h";

struct Resource {
  id: i32;

  function relay(move this): Resource {
    return this;
  }

  function finish(move this, offset: i32): i32 {
    this.id = this.id + offset;
    return this.id;
  }

  deinit {
    stdio.printf("drop=%d\n", this.id);
  }
}

struct Point {
  value: i32;

  function take(): i32 {
    return this.value;
  }
}

function main(): i32 {
  const first = Resource({ id: 40 });
  const second = first.relay();
  const result = second.finish(2);

  const point = Point({ value: 7 });
  const copied = point.take();
  stdio.printf("result=%d copy=%d,%d\n", result, copied, point.value);
  return 0;
}
