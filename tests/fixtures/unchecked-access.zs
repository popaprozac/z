struct Frame {
  registers: Array<i32>;
  base: usize;
  latest: i32;

  function reg(index: u8): i32 {
    return unsafe {
      select this.registers.uncheckedAt(this.base + usize(index));
    };
  }

  // The selected value assigned to a field.
  function remember(inout this, index: u8): void {
    this.latest = unsafe {
      select this.registers.uncheckedAt(this.base + usize(index));
    };
  }

  function setReg(inout this, index: u8, value: i32): void {
    unsafe {
      this.registers.uncheckedSet(this.base + usize(index), value);
    }
  }
}

function sum(values: Slice<i32>): i32 {
  let total = 0;
  let index: usize = 0;
  while (index < values.length) {
    const item = unsafe { select values.uncheckedAt(index); };
    total = total + item;
    index = index + 1;
  }
  return total;
}

// The selected value assigned to a binding declared before the loop.
function last(values: Slice<i32>): i32 {
  let item = 0;
  let index: usize = 0;
  while (index < values.length) {
    item = unsafe { select values.uncheckedAt(index); };
    index = index + 1;
  }
  return item;
}

function main(): i32 {
  let frame = Frame({ registers: Array<i32>(0, 0, 0, 0), base: 1, latest: 0 });
  frame.setReg(0, 20);
  frame.setReg(2, 22);
  let fixed = [1, 2, 3];
  unsafe {
    fixed.uncheckedSet(2, 30);
  }
  const first = unsafe { select fixed.uncheckedAt(0); };
  if (frame.reg(0) + frame.reg(2) != 42) return 1;
  if (sum(frame.registers) != 42 || first + fixed[2] != 31) return 2;
  frame.remember(2);
  if (last(frame.registers) != 22 || frame.latest != 22) return 3;
  return 0;
}
