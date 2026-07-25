# Z diagnostics

Diagnostics are part of Z's language ergonomics. The compiler reports a stable
code, a primary error location, relevant secondary locations, explanatory
notes, and actionable help when the compiler can recommend a safe correction.

```text
example.zs:9:10: error[Z0201]: use of moved value "first"
  |
9 |   return first.id + second.id;
  |          ^^^^^ use of moved value "first"
  ::: example.zs:8:18
  |
8 |   const second = first;
  |                  ^^^^^ ownership was transferred here
  note: ownership-bearing values have a single owner and cannot be used after ownership transfers
  help: borrow the value with an `in` parameter when ownership transfer is unnecessary, or stop using it after the transfer
```

The bootstrap reserves these code families:

| Range | Area |
|---|---|
| `Z01xx` | numeric safety and arithmetic |
| `Z02xx` | ownership, moves, borrows, and captures |
| `Z03xx` | initialization, parameter capabilities, and collection access |
| `Z04xx` | formatting, console, and string construction |
| `Z07xx` | async effects, task structure, and suspension safety |
| `Z08xx` | foreign declaration and API-contract normalization |

Currently structured codes include:

| Code | Meaning |
|---|---|
| `Z0101` | compile-time integer overflow |
| `Z0102` | compile-time integer division or remainder by zero |
| `Z0103` | compile-time shift count outside the integer width |
| `Z0104` | invalid explicit numeric construction or conversion |
| `Z0201` | use or capture after ownership transfer |
| `Z0202` | value may move on another control-flow path |
| `Z0203` | attempted ownership transfer through a borrow |
| `Z0204` | attempted extraction of a cleanup-bearing field or element from owning aggregate storage |
| `Z0205` | mutation or ownership transfer conflicts with a live receiver-tied view |
| `Z0206` | receiver-tied view escapes or uses an unsupported provenance/storage shape |
| `Z0210` | mutation through an immutable closure capture |
| `Z0211` | cleanup-bearing move capture needs an explicitly typed owned closure |
| `Z0212` | borrowed capturing closure cannot become a storable function value |
| `Z0213` | environment-carrying function value cannot cross a context-free C callback boundary |
| `Z0214` | an escaping C callback declaration is missing its explicit thread or release contract |
| `Z0215` | closure parameter type cannot be inferred without a contextual function type |
| `Z0216` | throwing closure cannot become a general stored function value |
| `Z0217` | explicit copy requested for a type without an independent-copy capability |
| `Z0218` | explicit move requested for a view, non-owning value, or type without move capability |
| `Z0220` | object binding pattern or partial aggregate extraction is invalid for the source type |
| `Z0230` | borrowed match requires named, stored enum storage |
| `Z0231` | ownership-bearing pattern field cannot be extracted from borrowed match storage |
| `Z0240` | native value storage is used in a context without a proven relocation/initialization contract |
| `Z0301` | invalid or missing `inout` capability |
| `Z0302` | invalid or missing `out` capability |
| `Z0303` | read before initialization |
| `Z0304` | value may be uninitialized on another path |
| `Z0305` | out parameter is not initialized on every success path |
| `Z0310` | value is not valid stored collection iteration input |
| `Z0311` | structural collection mutation conflicts with iteration borrow |
| `Z0401` | console method or value has no supported formatter |
| `Z0402` | formatting a cleanup-bearing temporary requires stored ownership |
| `Z0403` | console is used without an explicit standard-module import |
| `Z0501` | invalid standard-module path, import shape, or export |
| `Z0601` | circular Z source-module import |
| `Z0602` | missing Z module or exported declaration |
| `Z0603` | duplicate source-module export or binding |
| `Z0700` | async program is valid but uses a shape outside the current executable lowering tier |
| `Z0701` | invalid `await` context or operand |
| `Z0702` | async call is missing `await` or `task` |
| `Z0703` | `task` or `async scope` is outside its required structured context |
| `Z0704` | borrowed storage could remain live in a task or across suspension |
| `Z0801` | malformed, unmatched, or conflicting foreign API contract metadata |
| `Z0802` | native declaration is unavailable for the explicit project deployment target |
| `Z0803` | no unique viable native overload exists for a foreign call |
| `Z0804` | native declaration is deprecated for the explicit project deployment target |
| `Z0805` | a typed native status result is called without `try` or `attempt` |
| `Z0810` | Objective-C protocol adaptation or protocol-property binding is invalid |
| `Z0811` | a native callback connection is malformed or its ownership-bearing token is discarded |
| `Z0820` | raw native source uses an unsupported declaration, context, or operand capability |
| `Z0821` | a value representation cannot cross the first raw native boundary |

CLI diagnostics render source context. Language-server diagnostics expose the
same code and message, secondary locations through related information, and
machine-readable help text for future editor quick fixes.

Suggestions must describe functionality that exists. For example, the
bootstrap does not recommend `move` for a cleanup-bearing escaping closure,
because owned closure environments are still deferred. It instead recommends a
safe non-escaping shape and explains the current limitation.
