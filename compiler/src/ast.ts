export type SourceLocation = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

export type Program = {
  readonly kind: "program";
  readonly imports: ImportDeclaration[];
  readonly structs: StructDeclaration[];
  readonly enums: EnumDeclaration[];
  readonly functions: FunctionDeclaration[];
};

export type ImportDeclaration = {
  readonly kind: "import";
  readonly moduleName: string;
  readonly bindings: ImportBinding[] | null;
  readonly header: string;
  readonly location: SourceLocation;
};

export type ImportBinding = {
  readonly importedName: string;
  readonly localName: string;
  readonly location: SourceLocation;
};

export type StructDeclaration = {
  readonly kind: "struct";
  readonly name: string;
  readonly fields: FieldDeclaration[];
  readonly methods: FunctionDeclaration[];
  readonly deinitializer: DeinitDeclaration | null;
  readonly location: SourceLocation;
};

export type DeinitDeclaration = {
  readonly kind: "deinit";
  readonly body: Statement[];
  readonly location: SourceLocation;
};

export type FieldDeclaration = {
  readonly name: string;
  readonly type: TypeReference;
  readonly location: SourceLocation;
};

export type EnumDeclaration = {
  readonly kind: "enum";
  readonly name: string;
  readonly variants: EnumVariant[];
  readonly location: SourceLocation;
};

export type EnumVariant = {
  readonly name: string;
  readonly payload: TypeReference | null;
  readonly location: SourceLocation;
};

export type FunctionDeclaration = {
  readonly kind: "function";
  readonly name: string;
  readonly receiverMode: "inout" | "move" | null;
  readonly parameters: Parameter[];
  readonly returnType: TypeReference;
  readonly errorType: TypeReference | null;
  readonly body: Statement[];
  readonly location: SourceLocation;
};

export type Parameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout";
  readonly type: TypeReference;
  readonly location: SourceLocation;
};

export type TypeReference = {
  readonly name: string;
  readonly location: SourceLocation;
};

export type Statement =
  | VariableStatement
  | AssignmentStatement
  | ReturnStatement
  | ThrowStatement
  | YieldStatement
  | ExpressionStatement
  | BlockStatement
  | IfStatement
  | MatchStatement;

export type VariableStatement = {
  readonly kind: "variable";
  readonly mutable: boolean;
  readonly name: string;
  readonly type: TypeReference | null;
  readonly initializer: Expression;
  readonly location: SourceLocation;
};

export type AssignmentStatement = {
  readonly kind: "assignment";
  readonly target: IdentifierExpression | MemberExpression;
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type ReturnStatement = {
  readonly kind: "return";
  readonly expression: Expression | null;
  readonly location: SourceLocation;
};

export type ThrowStatement = {
  readonly kind: "throw";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type YieldStatement = {
  readonly kind: "yield";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type ExpressionStatement = {
  readonly kind: "expressionStatement";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type BlockStatement = {
  readonly kind: "block";
  readonly statements: Statement[];
  readonly location: SourceLocation;
};

export type IfStatement = {
  readonly kind: "if";
  readonly condition: Expression;
  readonly thenBranch: BlockStatement;
  readonly elseBranch: BlockStatement | IfStatement | null;
  readonly location: SourceLocation;
};

export type MatchStatement = {
  readonly kind: "match";
  readonly expression: Expression;
  readonly arms: MatchArm[];
  readonly location: SourceLocation;
};

export type MatchArm = {
  readonly variantName: string;
  readonly binding: string | null;
  readonly body: Statement;
  readonly location: SourceLocation;
};

export type Expression =
  | NumberExpression
  | StringExpression
  | BooleanExpression
  | IdentifierExpression
  | UnaryExpression
  | BinaryExpression
  | CallExpression
  | MemberExpression
  | StructExpression
  | VariantExpression
  | AttemptExpression
  | TryExpression
  | MatchExpression
  | ArgumentReferenceExpression;

export type NumberExpression = {
  readonly kind: "number";
  readonly value: string;
  readonly location: SourceLocation;
};

export type StringExpression = {
  readonly kind: "string";
  readonly value: string;
  readonly location: SourceLocation;
};

export type BooleanExpression = {
  readonly kind: "boolean";
  readonly value: boolean;
  readonly location: SourceLocation;
};

export type UnaryExpression = {
  readonly kind: "unary";
  readonly operator: string;
  readonly operand: Expression;
  readonly location: SourceLocation;
};

export type IdentifierExpression = {
  readonly kind: "identifier";
  readonly name: string;
  readonly location: SourceLocation;
};

export type BinaryExpression = {
  readonly kind: "binary";
  readonly operator: string;
  readonly left: Expression;
  readonly right: Expression;
  readonly location: SourceLocation;
};

export type CallExpression = {
  readonly kind: "call";
  readonly callee: Expression;
  readonly arguments: Expression[];
  readonly location: SourceLocation;
};

export type MemberExpression = {
  readonly kind: "member";
  readonly object: Expression;
  readonly property: string;
  readonly location: SourceLocation;
};

export type StructExpression = {
  readonly kind: "structExpression";
  readonly typeName: string;
  readonly fields: FieldInitializer[];
  readonly location: SourceLocation;
};

export type FieldInitializer = {
  readonly name: string;
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type VariantExpression = {
  readonly kind: "variantExpression";
  readonly enumName: string;
  readonly variantName: string;
  readonly payload: Expression;
  readonly location: SourceLocation;
};

export type AttemptExpression = {
  readonly kind: "attempt";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type TryExpression = {
  readonly kind: "try";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type MatchExpression = {
  readonly kind: "matchExpression";
  readonly expression: Expression;
  readonly arms: MatchArm[];
  readonly location: SourceLocation;
};

export type ArgumentReferenceExpression = {
  readonly kind: "argumentReference";
  readonly access: "out" | "inout";
  readonly name: string;
  readonly location: SourceLocation;
};
