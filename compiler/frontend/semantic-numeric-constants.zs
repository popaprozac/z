import { ExpressionKind, ExpressionTree } from "./parser.zs";
import { ParsedModule } from "./module-symbols.zs";
import { ModuleResolveError, ModuleResolveErrorKind, moduleResolutionError } from "./semantic-model.zs";

// A signed magnitude covers every Z integer, including the i64 minimum and
// u64 maximum, without overflowing the compiler while checking source arithmetic.
struct IntegerMagnitude {
  negative: boolean;
  magnitude: u64;
}

function integerWidth(in name: String): u64 {
  if (name == "u8" || name == "i8") return 8;
  if (name == "u16" || name == "i16") return 16;
  if (name == "u32" || name == "i32") return 32;
  return 64;
}

function shiftConstant(
  in module: ParsedModule,
  in tree: ExpressionTree,
  index: usize,
  in typeName: String
): Option<IntegerMagnitude> throws ModuleResolveError {
  const node = view tree.nodes[index];
  if (node.kind == ExpressionKind.numberExpression) {
    let magnitude: u64 = 0;
    let offset: usize = 0;
    while (offset < node.value.byteLength) {
      const byte = node.value.byteAt(offset);
      if (byte < 48 || byte > 57) return Option.none;
      const digit = u64(byte - 48);
      const maximum: u64 = 0xFFFF_FFFF_FFFF_FFFF;
      if (magnitude > (maximum - digit) / 10) return Option.none;
      magnitude = magnitude * 10 + digit;
      offset = offset + 1;
    }
    return Option.some(IntegerMagnitude({ negative: false, magnitude }));
  }
  if (node.kind == ExpressionKind.unaryExpression && node.children.length == 1
    && (node.value == "+" || node.value == "-")) {
    const operand = try shiftConstant(module, tree, node.children[0], typeName);
    return match (operand) {
      some(value) => Option.some(IntegerMagnitude({
        negative: value.magnitude != 0 && (node.value == "-" ? !value.negative : value.negative),
        magnitude: value.magnitude,
      }));
      none => Option.none;
    };
  }
  if (node.kind != ExpressionKind.binaryExpression || node.children.length != 2
    || (node.value != "<<" && node.value != ">>")) return Option.none;
  const left = try shiftConstant(module, tree, node.children[0], typeName);
  const right = try shiftConstant(module, tree, node.children[1], typeName);
  return match (left) {
    none => Option.none;
    some(value) => match (right) {
      none => Option.none;
      some(count) => {
        const width = integerWidth(typeName);
        if (count.negative || count.magnitude >= width) {
          throw moduleResolutionError(ModuleResolveErrorKind.invalidOperator, module.path,
            `shift count is outside the range for ${typeName}`, node.line, node.column);
        }
        let magnitude = value.magnitude;
        if (node.value == "<<") {
          let maximum: u64 = 0xFFFF_FFFF_FFFF_FFFF;
          if (typeName.byteAt(0) == 105) {
            maximum = u64(1) << (width - 1);
            if (!value.negative) maximum = maximum - 1;
          } else if (width < 64) maximum = (u64(1) << width) - 1;
          if (magnitude > (maximum >> count.magnitude)) {
            throw moduleResolutionError(ModuleResolveErrorKind.invalidOperator, module.path,
              `constant integer expression overflows ${typeName}`, node.line, node.column);
          }
          magnitude = magnitude << count.magnitude;
        } else {
          const discarded = magnitude & ((u64(1) << count.magnitude) - 1);
          magnitude = magnitude >> count.magnitude;
          // Signed right shift rounds toward negative infinity, not zero.
          if (value.negative && discarded != 0) magnitude = magnitude + 1;
        }
        select Option.some(IntegerMagnitude({ negative: value.negative && magnitude != 0, magnitude }));
      }
    }
  };
}

export function validateConstantShift(
  in module: ParsedModule, in tree: ExpressionTree, index: usize, in typeName: String
): void throws ModuleResolveError {
  // Nonconstant operands remain subject to the ordinary checked runtime helper.
  const checked = try shiftConstant(module, tree, index, typeName);
}

export function validateWrappingShiftCount(
  in module: ParsedModule, in tree: ExpressionTree, index: usize, in typeName: String
): void throws ModuleResolveError {
  // The receiver need not be constant: only the count determines this check.
  const count = try shiftConstant(module, tree, index, "usize");
  match (count) {
    some(value) => {
      if (value.negative || value.magnitude >= integerWidth(typeName)) {
        throw moduleResolutionError(ModuleResolveErrorKind.invalidOperator, module.path,
          `shift count is outside the range for ${typeName}; wrappingShiftLeft wraps result bits, not the count`,
          tree.nodes[index].line, tree.nodes[index].column);
      }
    }
    none => {}
  }
}
