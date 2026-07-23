export type SourceLocation = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly fileName?: string;
};

export type Program = {
  readonly kind: "program";
  readonly imports: ImportDeclaration[];
  readonly exports: ExportDeclaration[];
  readonly typeAliases: TypeAliasDeclaration[];
  readonly traits: TraitDeclaration[];
  readonly structs: StructDeclaration[];
  readonly enums: EnumDeclaration[];
  readonly functions: FunctionDeclaration[];
};

export type ExportDeclaration = {
  readonly name: string;
  readonly declarationKind: "function" | "struct" | "class" | "trait" | "enum" | "type";
  readonly location: SourceLocation;
};

export type TypeAliasDeclaration = {
  readonly kind: "type";
  readonly name: string;
  readonly target: TypeReference;
  readonly location: SourceLocation;
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
  readonly kind: "struct" | "class";
  readonly name: string;
  readonly typeParameters?: string[];
  readonly typeParameterConstraints?: TypeParameterConstraint[];
  readonly implements: TypeReference[];
  readonly fields: FieldDeclaration[];
  readonly constructor: ConstructorDeclaration | null;
  readonly methods: FunctionDeclaration[];
  readonly deinitializer: DeinitDeclaration | null;
  readonly location: SourceLocation;
};

export type TraitDeclaration = {
  readonly kind: "trait";
  readonly name: string;
  readonly typeParameters?: string[];
  readonly typeParameterConstraints?: TypeParameterConstraint[];
  readonly intrinsic?: "iterator";
  readonly methods: FunctionDeclaration[];
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
  readonly visibility: "public" | "private";
  readonly readonly: boolean;
  readonly location: SourceLocation;
};

export type ConstructorDeclaration = {
  readonly kind: "constructor";
  readonly parameters: Parameter[];
  readonly errorType: TypeReference | null;
  readonly body: Statement[];
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
  readonly async?: boolean;
  readonly static?: boolean;
  readonly visibility?: "public" | "private";
  readonly typeParameters?: string[];
  readonly typeParameterConstraints?: TypeParameterConstraint[];
  readonly receiverMode: "inout" | "move" | null;
  readonly parameters: Parameter[];
  readonly returnType: TypeReference;
  readonly errorType: TypeReference | null;
  /** Objective-C selector exported by a protocol-conforming class method. */
  readonly nativeSelector?: string | null;
  readonly body: Statement[];
  readonly location: SourceLocation;
};

export type TypeParameterConstraint = {
  readonly parameter: string;
  readonly traits: TypeReference[];
  readonly location: SourceLocation;
};

export type Parameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout" | "out";
  readonly type: TypeReference;
  readonly location: SourceLocation;
};

export type ClosureParameter = {
  readonly name: string;
  readonly mode: "value" | "in" | "inout" | "out";
  readonly type: TypeReference | null;
  readonly location: SourceLocation;
};

export type TypeReference = {
  readonly name: string;
  readonly location: SourceLocation;
};

export type Statement =
  | VariableStatement
  | DestructureStatement
  | AssignmentStatement
  | ReturnStatement
  | ThrowStatement
  | YieldStatement
  | SelectStatement
  | ExpressionStatement
  | BlockStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | BreakStatement
  | ContinueStatement
  | AsyncScopeStatement
  | MatchStatement;

export type AsyncScopeStatement = {
  readonly kind: "asyncScope";
  readonly body: BlockStatement;
  readonly location: SourceLocation;
};

export type VariableStatement = {
  readonly kind: "variable";
  readonly mutable: boolean;
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: TypeReference | null;
  readonly initializer: Expression | null;
  readonly location: SourceLocation;
};

export type DestructureStatement = {
  readonly kind: "destructure";
  readonly mutable: boolean;
  readonly objectBindings: MatchObjectBinding[];
  readonly type: TypeReference | null;
  readonly initializer: Expression;
  readonly location: SourceLocation;
};

export type AssignmentStatement = {
  readonly kind: "assignment";
  readonly target: IdentifierExpression | MemberExpression | IndexExpression;
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

export type SelectStatement = {
  readonly kind: "select";
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

export type WhileStatement = {
  readonly kind: "while";
  readonly condition: Expression;
  readonly body: BlockStatement;
  readonly location: SourceLocation;
};

export type ForStatement = {
  readonly kind: "for";
  readonly asynchronous: boolean;
  readonly errorMode: "none" | "try";
  readonly mode: "auto" | "inout";
  readonly binding: string | null;
  readonly bindingLocation: SourceLocation | null;
  readonly objectBindings: MatchObjectBinding[] | null;
  readonly iterable: Expression;
  readonly body: BlockStatement;
  readonly location: SourceLocation;
};

export type BreakStatement = {
  readonly kind: "break";
  readonly location: SourceLocation;
};

export type ContinueStatement = {
  readonly kind: "continue";
  readonly location: SourceLocation;
};

export type MatchStatement = {
  readonly kind: "match";
  readonly mode: "auto" | "in";
  readonly expression: Expression;
  readonly arms: MatchArm[];
  readonly location: SourceLocation;
};

export type MatchArm = {
  readonly variantName: string;
  readonly binding: string | null;
  readonly bindingLocation: SourceLocation | null;
  readonly objectBindings: MatchObjectBinding[] | null;
  readonly body: Statement;
  readonly location: SourceLocation;
};

export type MatchObjectBinding = {
  readonly fieldName: string;
  readonly bindingName: string;
  readonly fieldLocation: SourceLocation;
  readonly bindingLocation: SourceLocation;
};

export type Expression =
  | NumberExpression
  | StringExpression
  | TemplateExpression
  | BooleanExpression
  | NullExpression
  | IdentifierExpression
  | UnaryExpression
  | BinaryExpression
  | ConditionalExpression
  | NewExpression
  | WeakExpression
  | ClosureExpression
  | CallExpression
  | MemberExpression
  | IndexExpression
  | ArrayExpression
  | DynamicArrayExpression
  | StructExpression
  | ObjectExpression
  | VariantExpression
  | AttemptExpression
  | TryExpression
  | AwaitExpression
  | SpawnExpression
  | ExecutorPlacementExpression
  | MatchExpression
  | IfExpression
  | WhileExpression
  | ForExpression
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

export type TemplateExpression = {
  readonly kind: "template";
  readonly parts: TemplatePart[];
  readonly location: SourceLocation;
};

export type TemplatePart =
  | { readonly kind: "text"; readonly value: string; readonly location: SourceLocation }
  | { readonly kind: "value"; readonly expression: Expression; readonly location: SourceLocation };

export type BooleanExpression = {
  readonly kind: "boolean";
  readonly value: boolean;
  readonly location: SourceLocation;
};

export type NullExpression = {
  readonly kind: "null";
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

export type ConditionalExpression = {
  readonly kind: "conditional";
  readonly condition: Expression;
  readonly thenExpression: Expression;
  readonly elseExpression: Expression;
  readonly location: SourceLocation;
};

export type NewExpression = {
  readonly kind: "new";
  readonly typeName: string;
  readonly arguments: Expression[];
  readonly argumentLabels: (string | null)[];
  readonly location: SourceLocation;
};

export type WeakExpression = {
  readonly kind: "weak";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type ClosureExpression = {
  readonly kind: "closure";
  readonly captureMode: "borrow" | "move";
  readonly parameters: ClosureParameter[];
  readonly returnType: TypeReference | null;
  readonly errorType: TypeReference | null;
  readonly body: Expression | BlockStatement;
  readonly location: SourceLocation;
};

export type CallExpression = {
  readonly kind: "call";
  readonly callee: Expression;
  readonly arguments: Expression[];
  readonly argumentLabels: (string | null)[];
  readonly location: SourceLocation;
};

export type MemberExpression = {
  readonly kind: "member";
  readonly object: Expression;
  readonly property: string;
  readonly location: SourceLocation;
};

export type IndexExpression = {
  readonly kind: "index";
  readonly object: Expression;
  readonly index: Expression;
  readonly location: SourceLocation;
};

export type ArrayExpression = {
  readonly kind: "arrayExpression";
  readonly elements: Expression[];
  readonly location: SourceLocation;
};

export type DynamicArrayExpression = {
  readonly kind: "dynamicArrayExpression";
  readonly elementType: string;
  readonly location: SourceLocation;
};

export type StructExpression = {
  readonly kind: "structExpression";
  readonly typeName: string;
  readonly fields: FieldInitializer[];
  readonly location: SourceLocation;
};

export type ObjectExpression = {
  readonly kind: "objectExpression";
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

export type AwaitExpression = {
  readonly kind: "await";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type SpawnExpression = {
  readonly kind: "spawn";
  readonly expression: Expression;
  readonly location: SourceLocation;
};

export type ExecutorPlacementExpression = {
  readonly kind: "executorPlacement";
  readonly mode: "sync" | "await" | "spawn";
  readonly executor: Expression;
  readonly returnType: TypeReference | null;
  readonly errorType: TypeReference | null;
  readonly body: BlockStatement;
  readonly location: SourceLocation;
  readonly onLocation: SourceLocation;
};

export type MatchExpression = {
  readonly kind: "matchExpression";
  readonly mode: "auto" | "in";
  readonly expression: Expression;
  readonly arms: MatchArm[];
  readonly location: SourceLocation;
};

export type IfExpression = {
  readonly kind: "ifExpression";
  readonly condition: Expression;
  readonly thenBranch: BlockStatement;
  readonly elseBranch: BlockStatement | IfExpression;
  readonly location: SourceLocation;
};

export type WhileExpression = {
  readonly kind: "whileExpression";
  readonly condition: Expression;
  readonly body: BlockStatement;
  readonly elseBranch: BlockStatement;
  readonly location: SourceLocation;
};

export type ForExpression = {
  readonly kind: "forExpression";
  readonly mode: "auto" | "inout";
  readonly binding: string | null;
  readonly bindingLocation: SourceLocation | null;
  readonly objectBindings: MatchObjectBinding[] | null;
  readonly iterable: Expression;
  readonly body: BlockStatement;
  readonly elseBranch: BlockStatement;
  readonly location: SourceLocation;
};

export type ArgumentReferenceExpression = {
  readonly kind: "argumentReference";
  readonly access: "out" | "inout";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly location: SourceLocation;
};
