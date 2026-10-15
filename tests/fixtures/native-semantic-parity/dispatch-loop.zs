import console from "std/console";

// A register machine whose loop is marked `dispatch while`: each arm becomes
// a handler of its own where the C compiler can chain them by tail calls, and
// the program means the same either way.
enum Op {
  load,
  add,
  dec,
  jumpIfNotZero,
  show,
  nop,
  halt,
}

struct Inst {
  op: Op;
  a: i32;
  b: i32;
}

struct Machine {
  regs: Array<i32>;
  code: Array<Inst>;

  function emit(inout this, op: Op, a: i32, b: i32): void {
    this.code.push(Inst({ op, a, b }));
  }

  function run(inout this, limit: i32): i32 {
    let ip: usize = 0;
    let steps: i32 = 0;
    let shown: i32 = 0;
    let result: i32 = -1;
    dispatch while (true) {
      const inst = this.code[ip];
      ip = ip + 1;
      steps = steps + 1;
      match (inst.op) {
        load => {
          this.regs[usize(inst.a)] = inst.b;
          continue;
        }
        add => {
          this.regs[usize(inst.a)] = this.regs[usize(inst.a)] + this.regs[usize(inst.b)];
          continue;
        }
        dec => {
          this.regs[usize(inst.a)] = this.regs[usize(inst.a)] - 1;
        }
        jumpIfNotZero => {
          if (this.regs[usize(inst.a)] != 0) {
            ip = usize(inst.b);
            continue;
          }
        }
        show => {
          const label: String = "acc";
          console.log(label, this.regs[usize(inst.a)]);
          shown = shown + 1;
        }
        halt => {
          result = this.regs[1];
          break;
        }
        _ => {}
      }
      // Arms that fall off their end come here.
      if (steps >= limit) {
        result = -2;
        break;
      }
    }
    console.log("steps", steps, "shown", shown);
    return result;
  }
}

enum Phase {
  odd,
  even,
  done,
}

// A free function, with no receiver to carry, and an arm whose own loop's
// `break` stays its own.
function sumTo(limit: i32): i32 {
  let total = 0;
  let step = 0;
  dispatch while (true) {
    step = step + 1;
    const phase = step > limit ? Phase.done : step % 2 == 0 ? Phase.even : Phase.odd;
    match (phase) {
      odd => {
        total = total + step;
      }
      even => {
        let halves = 0;
        while (true) {
          halves = halves + 1;
          if (halves == 2) break;
        }
        total = total + step * halves / 2;
        continue;
      }
      done => {
        break;
      }
    }
  }
  return total;
}

// `dispatch` stays an ordinary name elsewhere.
function names(): i32 {
  const dispatch = 2;
  return dispatch;
}

function main(): i32 {
  let machine = Machine({ regs: Array<i32>(), code: Array<Inst>() });
  machine.regs.push(0);
  machine.regs.push(0);
  machine.emit(Op.load, 0, 10);
  machine.emit(Op.load, 1, 0);
  machine.emit(Op.add, 1, 0);
  machine.emit(Op.dec, 0, 0);
  machine.emit(Op.jumpIfNotZero, 0, 2);
  machine.emit(Op.nop, 0, 0);
  machine.emit(Op.show, 1, 0);
  machine.emit(Op.halt, 0, 0);
  const result = machine.run(1000);
  console.log("result", result);
  const limited = machine.run(5);
  console.log("limited", limited);
  const total = sumTo(10);
  console.log("sum", total, names());
  return 0;
}
