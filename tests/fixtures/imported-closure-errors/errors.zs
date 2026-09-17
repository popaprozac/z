export struct Failure { message: String; }
export type Callback = () => i32 throws Failure;
