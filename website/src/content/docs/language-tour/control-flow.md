---
title: Control flow and expressions
description: Use familiar branches and loops, with explicit local values through select.
sidebar:
  order: 7
---

Z keeps familiar `if`, `while`, and `for...of` shapes while making the difference
between statement control flow and value-producing control flow explicit.

Conditions always require `boolean`:

```z
if (count > 0) {
  process(count);
}
```

Integers, strings, options, and native nullable handles do not participate in
truthiness.

## Statement branches

An `if` branch may use braces or contain one unbraced statement:

```z
if (value < 0) return -1;
if (value == 0) return 0;
return 1;
```

`else` binds to the nearest unmatched `if`, following the familiar
TypeScript/C-family rule.

Use a ternary for a concise two-way value:

```z
const label = ready ? "Ready" : "Waiting";
```

## `if` as an expression

A larger conditional can produce a value. Use `select` to supply the value of
the local expression block:

```z
const description = if (value == 10) {
  const label = "ten";
  select label;
} else if (value > 10) {
  select "large";
} else {
  select "small";
};
```

Every reachable branch must select one compatible type. Blocks do not return
their last expression implicitly.

`select`, `return`, and `throw` have deliberately different destinations:

| Keyword | Destination |
| --- | --- |
| `select value` | The nearest local value-producing block |
| `return value` | The enclosing function or closure invocation |
| `throw error` | The enclosing typed error channel |

That distinction remains stable even when control flow is nested.

## Statement loops

Z uses `while` and `for...of`:

```z
let total = 0;
let index: usize = 0;

while (index < values.length) {
  total = total + values[index];
  index = index + 1;
}

for (const value of values) {
  if (value < 0) continue;
  if (value == 0) break;
  inspect(value);
}
```

`continue` begins the next iteration. `break` exits a statement loop. Z does
not add JavaScript's `for...in`; collections expose values or typed entries
through `for...of` instead of iterating string property names.

## Loops as expressions

`while` and `for...of` can also produce values. Their required `else` block
handles natural exhaustion, including a loop that executes zero times:

```z
const firstEven: Option<i32> = for (const value of values) {
  if (value % 2 == 0) {
    select Option.some(value);
  }
} else {
  select Option.none;
};
```

```z
let attempts = 0;
const status = while (attempts < 3) {
  attempts = attempts + 1;
  if (ready()) {
    select "ready";
  }
} else {
  select "exhausted";
};
```

A plain `break` is invalid inside a value-producing loop because it would leave
the expression without a value. Use `select` to finish that loop with a value;
`return` and `throw` can still leave the enclosing function.

The first executable value-producing loop tier is synchronous. Check the
[implementation status](/reference/status/) before composing it with advanced
async control flow.

## Pattern matching

`match` is Z's exhaustive branch over nominal enum variants, `Option<T>`, and
`Result<T, E>`. It can be a statement or an expression and follows the same
`select` rule for multi-statement arms.

See [Enums and matching](/language-tour/enums-and-matching/) for construction,
payload binding, wildcard arms, and borrowed matches.

## Runtime nominal checks

Imported Objective-C identity supports a bounded `instanceof` check:

```z
const body = message.body;
if (body instanceof Foundation.NSString) {
  const text: String = body;
  consume(text);
}
```

The true branch narrows the binding. This is currently an Objective-C interop
operation, not general runtime reflection over arbitrary Z types.

:::note[Cost model]
Ordinary branches and loops lower to native control flow. `match` lowers to tag
selection. Value-producing forms do not allocate merely because they use
`select`; the selected value's own type determines movement and cleanup.
:::

Runnable examples:
[conditional expressions](https://github.com/popaprozac/z/blob/main/examples/language/control-flow/conditional-expressions.zs)
and [loop expressions](https://github.com/popaprozac/z/blob/main/examples/language/control-flow/loop-expressions.zs).

Next: [Collections and views](/language-tour/collections-and-views/).
