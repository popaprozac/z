---
title: Collections and views
description: Choose inline arrays, growable buffers, borrowed slices, maps, sets, and frozen storage deliberately.
sidebar:
  order: 8
---

Z separates owned collection storage from borrowed access:

| Shape | Storage and purpose |
| --- | --- |
| `T[N]` | Inline fixed-size owned array |
| `Array<T>` | Growable contiguous owned buffer |
| `Slice<T>` | Non-escaping pointer/length view over contiguous storage |
| `Map<K, V>` | Owned hash map from `std/collections` |
| `Set<T>` | Owned hash set from `std/collections` |
| `readonly Array/Map/Set` | Frozen owned storage with no structural mutation API |
| `view T` | Read-only projection of one value tied to an owner |

`Array<T>` is intrinsic and requires no import. `Map` and `Set` are standard
library types.

## Fixed and growable arrays

An array literal constructs fixed inline storage:

```z
let values: i32[4] = [10, 20, 30, 40];
values[2] = 42;
```

A dynamic array owns a growable buffer:

```z
const empty = Array<String>();
const names = Array<String>("lexer", "parser", "emitter");
const oneNumber = Array<i32>(42);
```

The one-argument form contains one element; it does not mean “reserve this much
capacity.” Arguments enter the array in source order under the same ownership
rules as `push`.

Reserve storage explicitly when the eventual size is known:

```z
let bytes = Array<u8>.withCapacity(1024); // empty; room for at least 1,024 bytes
bytes.push(65);
bytes.reserveCapacity(4096); // length stays 1
```

Both operations take a `usize` **minimum total element capacity**. To make room
for `extra` more elements, use `bytes.reserveCapacity(bytes.length + extra)`.
They never shrink, initialize extra elements, or relax checked indexing.
Sufficient capacity requires no allocation; `withCapacity(0)` remains
unallocated. Growth preserves existing values and their cleanup obligations.
`reserveCapacity` needs exclusive mutable storage, so live element views,
slices, and iteration borrows still prevent it. Allocation-size overflow and
allocation failure trap just as they do during normal `push` growth.

This avoids intermediate growth allocations, not allocations made by the
elements themselves. Ordinary `push` already grows the buffer geometrically.

Copy a run of elements onto the end in one step with `append`:

```z
let output = Array<u8>.withCapacity(64);
output.append(header); // header: u8[N], Array<u8>, or Slice<u8>
```

`append` takes anything that converts to `Slice<T>`. Its element type must be
cleanup-free (numbers, booleans, and plain value structs, enums, and fixed
arrays of them); push elements that own storage one at a time with an explicit
copy. Appending an array to itself is a compile-time error, because the call
borrows the source while it may grow the receiver.

`values.clear()` destroys every live element immediately in reverse order and
sets `length` to zero. The backing allocation and `capacity` remain available
for later `push` calls. Clearing requires mutable `let` storage and is rejected
while an element view or `for...of` borrow is live.

Use `pop()` when you want ownership of the last element:

```z
let history = Array<String>("Draft", "Published");
const previous = history.pop(); // Option<String>
match (previous) {
  some(title) => console.log(title);
  none => console.log("No previous revision");
}
```

`pop()` returns `none` when empty. Its container work is O(1): it retains capacity
without allocating or resizing the buffer and transfers rather than clones
the element. Native C++ move/destructor operations can have their own cost.
The returned owner handles
cleanup, independently of later changes to the array. As with `clear`, it
requires mutable storage and rejects live array views or iteration borrows.
An element containing an arena view still depends on that arena after removal.

Both shapes expose `.length` and checked indexing. A growable array may allocate
when it expands. Moving the whole array transfers its buffer; an indexed owned
element is borrowed rather than moved out, because extraction would leave a
hole in the containing owner.

An element view created before a loop remains borrowed when a later iteration
will read it again. Do not grow, replace, or clear its array inside that loop.
A view created within an iteration may finish at its last use before a `push`:
the next iteration acquires a fresh view. Once the loop has finished and the
view has no later uses, the owner becomes mutable again. These lifetime checks
happen at compile time; they do not add runtime borrow tracking.

A direct view of one array field does not freeze an independently owned sibling
array. In a mutable method, for example:

```z
const program = view this.code;
let ip: usize = 0;
while (ip < program.length) {
  this.registers[0] = this.registers[0] + program[ip];
  ip = ip + 1;
}
```

The method still needs `inout this`. `registers.push`, `registers.pop`, and
`registers.clear` also remain available, while writes to `code` are blocked
until the view's last use. Indexed elements of one array are not proved
disjoint, nested shared class identity remains conservative, and deeper views
through an indexed owner still loan the whole named owner. Bounds checks are
unchanged.

## Slices borrow contiguous storage

`Slice<T>` is a non-owning descriptor accepted by functions without copying the
elements:

```z
function sum(values: Slice<i32>): i32 {
  let total = 0;
  for (const value of values) {
    total = total + value;
  }
  return total;
}

const fixed = [10, 20, 12];
const dynamic = Array<i32>(20, 22);
const first = sum(fixed);
const second = sum(dynamic);
```

Slice parameters are already borrowed, so they do not add a redundant `in`.
`inout values: Slice<T>` grants mutable access to the borrowed elements while
still preventing the slice from escaping its backing owner.

Rest destructuring can create a local slice without allocation:

```z
let values = Array<i32>(10, 20, 30);
const [first, ...remaining] = view values;
inspect(remaining);
values.push(40); // valid after remaining's last use
```

The compiler rejects reallocation, movement, or destruction of `values` while
`remaining` is live.

## Maps make lookup ownership visible

```z
import { Map } from "std/collections";

struct User {
  id: i32;
  name: String;
}

let users = Map<String, User>();
users.set("ada", User({ id: 1, name: "Ada" }));

const found = users.get("ada");
const id = match (in found) {
  some(user) => user.id;
  none => 0;
};
```

For value types, `get` returns `Option<view V>` so lookup does not copy or
remove the stored value. Structural mutation is rejected until that view's last
use. For ARC classes and Objective-C identities, `get` returns an independently
retained shared reference instead.

Map operations distinguish transfer from destruction:

| Operation | Result |
| --- | --- |
| `set(key, value)` | Inserts or replaces; destroys the replaced value |
| `get(key)` | Borrows or retains according to the stored value shape |
| `remove(key)` | Transfers the stored value through `Option<V>` |
| `delete(key)` | Destroys the stored key/value and returns `boolean` |
| `clear()` | Destroys every entry |

Use `remove` when the caller needs ownership of what was stored. Use `delete`
when only removal matters.

## Sets use the same vocabulary

```z
import { Set } from "std/collections";

let visited = Set<String>();
const inserted = visited.add("settings");
const present = visited.has("settings");
const removed = visited.remove("settings");
const deleted = visited.delete("obsolete");
visited.clear();
```

`add` reports whether insertion occurred. An equal existing value remains in
the set, and an incoming owned duplicate is destroyed. `remove` transfers the
stored value; `delete` destroys it directly.

## Iteration is borrowed

```z
for (const { key, value } of users) {
  console.log(`${key}: ${value.name}`);
}

for (const path of visited) {
  console.log(path);
}
```

A map produces typed `Map.Entry<K, V>` values with borrowed `.key` and `.value`
fields. A set borrows its stored `T`. Iteration does not permit moving elements
out or structurally mutating the collection before the loop ends. Hash
iteration order is unspecified.

Custom synchronous iteration uses the nominal `Iterator<T>` trait and an
`inout this` cursor. Generators build on the same `for...of` surface and will be
covered separately.

## Freeze before publication

Completed mutable storage can surrender structural mutation without copying:

```z
let routes = Map<String, Handler>();
routes.set("open", openHandler);

const handlers: readonly Map<String, Handler> = routes.freeze();
// routes has moved; handlers keeps lookup, iteration, length, and cleanup.
```

`freeze()` consumes the mutable owner and transfers its existing allocation.
There is no element copy, retain pass, or implicit thaw.

:::note[Cost model]
Fixed arrays are inline. `Array<T>` may allocate and move elements when it
grows. `append` performs one capacity check, at most one growth, and one block
copy. `Slice<T>` and local rest views are two-word borrowed descriptors. Maps
and sets own hash buckets; lookup is expected constant time but may compare or
hash user values. Safe indexing remains bounds-checked.
:::

Runnable examples:
[arrays](https://github.com/popaprozac/z/tree/main/examples/language/collections),
[maps](https://github.com/popaprozac/z/blob/main/examples/language/collections/map.zs),
and [sets](https://github.com/popaprozac/z/blob/main/examples/language/collections/set.zs).

Next: [Modules and exports](/language-tour/modules-and-exports/).
