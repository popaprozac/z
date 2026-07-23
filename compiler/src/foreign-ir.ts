export type ForeignScalarTypeName =
  | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "isize" | "usize" | "f32" | "f64" | "boolean";

export type ForeignSourceLocation = {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
};

export type ForeignAvailability = {
  readonly platform: string | null;
  readonly introduced: string | null;
  readonly deprecated: boolean;
  readonly deprecatedVersion: string | null;
  readonly obsoleted: string | null;
  readonly unavailable: boolean;
  readonly message: string | null;
};

export type ForeignDeclarationMetadata = {
  readonly source: ForeignSourceLocation | null;
  readonly availability: readonly ForeignAvailability[];
};

export type ForeignType =
  | { readonly kind: "z"; readonly name: ForeignScalarTypeName | "cstring" | "void"; readonly cName: string }
  | { readonly kind: "nullPointer"; readonly cName: string }
  | { readonly kind: "fixedNative"; readonly cName: string; readonly expression: string }
  | { readonly kind: "selector"; readonly cName: "SEL" }
  | { readonly kind: "swiftString"; readonly cName: "swift::String" }
  | { readonly kind: "named"; readonly type: ForeignNamedType; readonly cName: string }
  | ForeignReferenceType
  | ForeignCallbackType
  | ForeignCallbackContextType
  | ForeignCallbackReleaseType
  | ForeignBlockType
  | ForeignObjectType
  | ForeignRecordPointerType
  | ForeignOutPointerType
  | ForeignPointerType
  | { readonly kind: "unsupported"; readonly cName: string };

export type ForeignNamedType = (
  | {
    readonly kind: "record";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly fields: readonly ForeignField[];
  }
  | {
    readonly kind: "value";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly lifecycle: ForeignValueLifecycle;
    readonly thread: ForeignThreadContract;
    readonly constructors: readonly ForeignFunctionOverload[];
    readonly staticMethods: readonly ForeignCxxStaticMethod[];
    readonly methods: readonly ForeignCxxMethod[];
  }
  | {
    readonly kind: "object";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly className: string;
  }
  | {
    readonly kind: "enum";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly flags: boolean;
    readonly underlying: ForeignScalarTypeName;
  }
  | {
    readonly kind: "scalar";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly underlying: ForeignScalarTypeName;
  }
) & {
  readonly namespacePath: readonly string[];
  readonly qualifiedName: string;
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignValueLifecycle = {
  readonly copy: boolean;
  readonly move: boolean;
  readonly deinit: boolean;
};

export type ForeignThreadContract = {
  readonly transfer: boolean;
  readonly share: boolean;
  readonly deinit: boolean;
};

export type ForeignCxxMethodOverload = ForeignFunctionOverload & {
  readonly receiverAccess: "in" | "inout" | "move";
};

export type ForeignCxxMethod = {
  readonly name: string;
  readonly overloads: readonly ForeignCxxMethodOverload[];
};

export type ForeignCxxStaticMethod = {
  readonly name: string;
  readonly overloads: readonly ForeignFunctionOverload[];
};

export type ForeignField = {
  readonly name: string;
  readonly typeName: string;
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignConstant = {
  readonly name: string;
  readonly cName: string;
  readonly typeName: string;
  readonly sourceKind: "enum" | "variable" | "macro";
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignObjectType = {
  readonly kind: "object";
  readonly typeName: string;
  readonly cName: string;
  readonly className: string | null;
  readonly nullable: boolean;
};

export type ForeignBlockType = {
  readonly kind: "block";
  readonly cName: string;
  readonly parameters: readonly ForeignType[];
  readonly returnType: ForeignType;
  readonly escaping: boolean;
  readonly nullable: boolean;
};

export type ForeignObjCMethod = {
  readonly selector: string;
  readonly baseName: string;
  readonly instance: boolean;
  readonly returnsInstanceType: boolean;
  readonly returnType: ForeignType;
  readonly parameters: readonly ForeignParameter[];
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignObjCPropertyOwnership =
  | "strong"
  | "copy"
  | "weak"
  | "assign"
  | "unsafeUnretained"
  | "unspecified";

export type ForeignObjCProperty = {
  readonly name: string;
  readonly getter: string;
  readonly setter: string | null;
  readonly classProperty: boolean;
  readonly readonly: boolean;
  readonly ownership: ForeignObjCPropertyOwnership;
  readonly type: ForeignType;
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignObjCInterface = {
  readonly exportName: string;
  readonly typeName: string;
  readonly className: string;
  readonly superName: string | null;
  readonly methods: readonly ForeignObjCMethod[];
  readonly properties: readonly ForeignObjCProperty[];
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignPointerType = {
  readonly kind: "pointer";
  readonly typeName: string;
  readonly cName: string;
  readonly identity: string;
  readonly ownership: "owned" | "borrowed" | "consuming";
  readonly nullable: boolean;
  readonly release: string | null;
  readonly thread: ForeignThreadContract;
  readonly stringView?: true;
};

export type ForeignOutPointerType = {
  readonly kind: "pointerOut";
  readonly cName: string;
  readonly pointer: ForeignPointerType;
};

export type ForeignRecordPointerType = {
  readonly kind: "recordPointer";
  readonly cName: string;
  readonly record: Extract<ForeignNamedType, { kind: "record" }>;
  readonly access: "in" | "out" | "inout";
  readonly nullable: boolean;
};

export type ForeignReferenceType = {
  readonly kind: "reference";
  readonly cName: string;
  readonly type: ForeignNamedType;
  readonly access: "in" | "inout" | "move";
};

export type ForeignParameter = {
  readonly name: string | null;
  readonly type: ForeignType;
};

export type ForeignCallbackType = {
  readonly kind: "callback";
  readonly cName: string;
  readonly parameters: readonly ForeignType[];
  readonly returnType: ForeignType;
  readonly lifetime: "call" | "escape";
  readonly context: {
    readonly parameter: number;
    readonly callbackParameter: number;
  } | null;
  readonly release: {
    readonly parameter: number;
    readonly callbackParameter: number;
  } | null;
  readonly thread: "caller" | null;
};

export type ForeignCallbackContextType = {
  readonly kind: "callbackContext";
  readonly cName: string;
  readonly callbackParameter: number;
};

export type ForeignCallbackReleaseType = {
  readonly kind: "callbackRelease";
  readonly cName: string;
  readonly callbackParameter: number;
};

export type ForeignFunctionOverload = {
  readonly name: string;
  readonly cName: string;
  readonly returnType: ForeignType;
  readonly status: {
    readonly success: readonly number[];
    readonly result: "void";
    readonly error: "return";
  } | null;
  readonly parameters: readonly ForeignParameter[];
  readonly variadic: boolean;
  readonly cSignature: string;
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignFunction = {
  readonly name: string;
  readonly namespacePath: readonly string[];
  readonly qualifiedName: string;
  readonly overloads: readonly ForeignFunctionOverload[];
};

// Producer-facing declarations intentionally contain only native spellings and
// ordering. Ownership, nullability, access, callback escape, and release facts
// are attached by the contract-normalization stage before sema sees the FIIR.
export type ForeignTypeSpelling = {
  readonly nativeName: string;
  readonly canonicalNativeName?: string;
};

export type ForeignParameterDeclaration = {
  readonly name: string | null;
  readonly type: ForeignTypeSpelling;
};

export type ForeignFunctionOverloadDeclaration = {
  readonly name: string;
  readonly nativeName: string;
  readonly returnType: ForeignTypeSpelling;
  readonly parameters: readonly ForeignParameterDeclaration[];
  readonly variadic: boolean;
  readonly nativeSignature: string;
  readonly metadata: ForeignDeclarationMetadata;
};

export type ForeignFunctionDeclaration = {
  readonly name: string;
  readonly namespacePath: readonly string[];
  readonly qualifiedName: string;
  readonly overloads: readonly ForeignFunctionOverloadDeclaration[];
};

export type ForeignDeclarationProducer = "clang" | "swift-interface" | "package-metadata" | "cache";

export type ForeignModuleDeclarations = {
  readonly producer: ForeignDeclarationProducer;
  readonly functions: ReadonlyMap<string, ForeignFunctionDeclaration>;
  readonly nativeTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly namedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly constants: ReadonlyMap<string, ForeignConstant>;
  readonly objectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly interfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly framework: string | null;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
};

export type ForeignModuleIR = {
  readonly producer: ForeignDeclarationProducer;
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly functionAliases: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
  readonly types: ReadonlyMap<string, ForeignPointerType>;
  readonly namedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly namedTypeAliases: ReadonlyMap<string, string>;
  readonly constants: ReadonlyMap<string, ForeignConstant>;
  readonly objectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly interfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly framework: string | null;
  readonly objectiveC: boolean;
  readonly cPlusPlus: boolean;
};
