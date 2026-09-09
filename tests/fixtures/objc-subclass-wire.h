// Header-only metadata oracle: no Foundation or native implementation required.
__attribute__((objc_root_class))
__attribute__((swift_attr("@MainActor")))
@interface ZWireBase
- (instancetype _Nonnull)initWithValue:(int)value __attribute__((objc_designated_initializer));
- (int)value;
- (int)requiredValue __attribute__((objc_requires_super));
- (int)directValue __attribute__((objc_direct));
- (void)consume __attribute__((ns_consumes_self));
- (void)takeIndex:(int)index object:(ZWireBase * __attribute__((ns_consumed)))object;
- (void)log:(int)count, ...;
- (long double)extendedValue __attribute__((objc_direct));
- (int)add:(int)left to:(int)right;
- (int)readObject:(ZWireBase * _Nonnull)object;
@property int configuredValue;
@property(readonly) int readOnlyValue;
@end

__attribute__((objc_subclassing_restricted))
@interface ZWireFinal : ZWireBase
@end

@interface ZWireChild : ZWireBase
@end

__attribute__((objc_root_class))
__attribute__((swift_attr("@MainActor")))
@interface ZWireNullable
- (instancetype _Nullable)initWithValue:(int)value __attribute__((objc_designated_initializer));
@end

__attribute__((objc_root_class))
@interface ZWireUnisolated
- (instancetype _Nonnull)initWithValue:(int)value __attribute__((objc_designated_initializer));
@end
