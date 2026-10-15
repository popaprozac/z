# Dispatch loops — design

Status: agreed with Zach on 2026-10-15. Z lowers an interpreter's loop
into handlers chained by tail calls, rather than adding a general tail
call. The spelling is `dispatch while`. Carried owned locals are
rejected. The emitted C carries both forms under a guard.
**Implemented** on 2026-10-15 in both compilers: the same rules and
messages, and the same lowering. The native C emitter picks the same
arguments as Stage 0 (`compiler/frontend/c-emitter.zs`, `dispatchPlan`).

## Why

A bytecode interpreter is one loop around one `match` over its
instructions. Z lowers that to a C `switch` in one large function, and the
C compiler's register allocation over the whole function is fragile: in
ZJS, an arm the program never runs has moved the hot arms' speed by up to
20%, and every change to the call and return arms moved register
allocation more than the work it removed.

ZJS measured the alternatives on a copy of its generated C, 2026-10-15
(ZJS `z/bench/speed/thread-dispatch.py`, results under
`z/bench/speed/results/2026-10-15-*-dispatch.json`):

- **Each arm a C function of its own**, ending in a tail call
  (`musttail`) to the next instruction's handler through a table, the
  loop's state in arguments under clang's `preserve_none`: calls -9%,
  helpers -9%, closures -8%, properties -4%, nothing slower; 16 KiB more
  text of 784; test262 unchanged.
- **The arms kept in one function, each ending in a computed goto**:
  6 to 56% slower. Spills in the loop went from 363 to 860.

The gain is in giving each instruction a register allocation of its own.
Z cannot write either form.

## Proposed source form

A contextual keyword before `while` marks the loop: `dispatch while`. The
engine's loop is unchanged apart from the mark:

```zs
dispatch while (true) {
  const inst = unsafe { select this.codeSegment.uncheckedAt(codeStart.wrappingAdd(ip)); };
  ip = ip.wrappingAdd(1);

  match (inst.op) {
    loadInt => {
      this.setReg(base, inst.a, int32Value(bcI16(inst)));
      continue;
    }
    returnOp => {
      // ...
      if (this.frameCount <= entryDepth) break;
      continue;
    }
    _ => {
      ip = this.runColdOp(inst, ip);
    }
  }
  if (this.pendingThrow) break;
}
```

**Meaning: exactly the unmarked loop.** Like `inline` and `cold`, the mark
changes where code goes, never what it does. A compiler may ignore it, and
the checker, the loan rules, and the diagnostics treat the loop as an
ordinary `while`. Removing the mark is always a valid program with the same
behavior.

## The shape the mark requires

The marked loop's body is a **prefix**, one **`match`**, and a **suffix**,
all at the body's top level:

- The prefix is straight-line statements: declarations and assignments, no
  loop, no `match`, no `try`, no suspension.
- The `match` subject is a value of a finite enum (no payloads). Its tag
  indexes the handler table.
- The suffix is statements run when an arm falls off its end (ZJS checks
  for a pending throw there). It may `break` or `continue`.
- Locals declared before the loop and used inside it must be
  cleanup-free. Owned values (String, Array, ARC classes) stay outside the
  loop or behind `this`.
- No `await` or `yield` in the loop, and the loop is not inside a
  generator or async function.

Anything else is a diagnostic at the mark ("dispatch loop: ..."), never
a silent fallback to the switch. An author who asked for the lowering
should know when they did not get it. Like `inline` and `cold`, the
diagnostics are not coded.

## Lowering

For a C compiler with `musttail` and `preserve_none`:

1. Every arm becomes a `static` handler with one signature: the enclosing
   function's receiver, the matched value's payload (for ZJS, the whole
   instruction), every carried local, and a pointer to a small exit
   record. Handlers use `preserve_none`, so the carried locals stay in
   registers that the helpers they call preserve.
2. A handler ends at each `continue` by running the prefix, then
   tail-calling `table[tag]` with the carried locals. When an arm falls
   off its end, the handler runs the suffix and then does the same.
3. `break` and `return` inside an arm store the carried locals (and the
   return value) into the exit record and return. The enclosing function
   copies the locals back. Then it continues after the loop, or returns.
   This path is cold.
4. The `_` arm is a handler too. It fills the table slots of every variant
   the `match` does not list.
5. Each arm's body exists once, in its handler. The switch form is not
   emitted beside it. A second copy would give every helper two callers
   and cost it single-caller inlining. That measured +4% on ZJS
   properties and +48 KiB.
6. The enclosing function enters the chain with one ordinary call to the
   first instruction's handler.

Which carried locals ride in arguments decides the speed, as ZJS
measured:

- At most nine arguments in all, receiver and record included.
  AArch64's `preserve_none` passes the first nine in x20-x28, which the
  helpers a handler calls preserve. Past them, every handler saves and
  reloads the rest around each call. The first version passed twelve,
  and was 6% slower than the hand-written prototype on calls and on
  properties.
- A prefix local is passed only when an arm or the suffix uses it. The
  match subject alone is spent picking the handler.
- A register goes first to a local the prefix or suffix uses. Next comes
  one that an instruction hands on to the next: assigned in the loop, and
  not only on the way out. Last comes one that a quarter of the arms read.
- A local set only on the way out stays in the record. Each of its
  assignments is followed, in its own statement list with only
  straight-line statements between, by a `break`. Every handler then sees
  its value from the loop's start. In ZJS these are the thrown value and
  the result.
- A handler reads and writes the record's locals in place, through the
  record pointer. Copying them in on entry and out on the way to the next
  handler cost a load and a store per instruction. Clang must assume that
  helper calls change the record, so it cannot remove those copies.

## Portability

The emitted C carries both forms under one guard, and the C compiler builds
one of them:

```c
#if defined(__has_attribute) && __has_attribute(musttail) && __has_attribute(preserve_none) /* && wasm tail calls */
  /* handlers and table */
#else
  /* the ordinary switch loop */
#endif
```

GCC, MSVC, and wasm without tail calls get today's switch loop and today's
speed. The generated C stays one file for embedders, and the program means
the same under either form.

## Cost model (for the reference)

- Dispatching one instruction is a load from the code, a load from the
  table, and an indirect jump. No frame is pushed and no stack grows.
- Each arm is compiled alone, so a new arm costs nothing in the others.
- Size: about one function prologue and one dispatch sequence per arm.
  For ZJS that is 2% of text.
- Leaving the loop writes the carried locals once.

## Decisions (2026-10-15)

1. Spelling: `dispatch while`. It marks the loop the lowering
   transforms, which is also the loop `continue` and `break` refer to.
   Considered and not taken: `dispatch match`.
2. Carried locals that own something are rejected with a diagnostic.
   Passing them by address through the exit record can come later if a
   program needs it.
3. Both forms go in the emitted C under one guard, so one generated file
   builds with any C compiler. Considered and not taken: a build setting
   that picks one form.
4. Payload enums as the subject are out of scope at first. A payload-free
   enum covers ZJS.

## Acceptance

- Both compilers: the mark parses as a contextual keyword, and the shape
  rules have the same diagnostics, with tests in
  `tests/native-semantic-parity.test.ts`.
- A fixture interpreter (an enum, a loop, ten arms, `break`, `return`, `_`)
  gives the same output with and without the mark, under clang and under
  the fallback guard.
- ZJS marks `runFrames`'s loop: the kernels land within noise of the
  prototype (calls -9%, closures -8%), test262 is unchanged, and the
  native build passes every gate.

## Where it goes

- Stage 0: `compiler/src/parser.ts` (the contextual keyword, as for `inline`
  and `cold`), `ast.ts`, the shape checks, and `codegen-c.ts` (the `while`
  emission).
- Native: `compiler/frontend/parser.zs`, `module-resolver.zs` (shape
  checks), `lowering-ir.zs` (the loop's `dispatch` label), and
  `c-emitter.zs`. The emitter writes each handler from a copy of the
  function that names the loop, so the existing `break`, `continue`, and
  local-name paths become the jump, the exit, and the record access.
- `docs/language-reference.md`: a section beside "Inline and cold
  functions"; `docs/diagnostics.md`: the new codes.

## Measured (2026-10-15)

ZJS marked its loop. It also changed its arms so that the error flags are
set only right before a `break`; the switch build of that change is level
against the old engine. Over eight placements and three runs, against the
unmarked engine:

| Kernel | Change |
|---|---|
| calls | -8.6 to -9.4% |
| helpers | -8.1 to -8.8% |
| closures | -6.3 to -7.3% |
| allocation | -3.8 to -4.8% |
| properties | -3.7 to -3.9% |
| strings | -3.2 to -4.6% |
| arrays, maps | -2% |
| json, regexp, polymorphic | level to -1.5% |

The lowering matches the hand-written prototype within noise, at the same
16 KiB of text.

