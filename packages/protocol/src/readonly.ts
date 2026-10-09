/**
 * Deep readonly: the helper behind the immutable session log (D9, issue #46).
 *
 * Once an event is appended, no field of it ever changes — that is the rule the whole replay
 * story rests on. Three things enforce it and this is the first of them: the store contract
 * has no method that modifies an event, the in-memory store hands out deep-frozen events, and
 * the event types are deep-readonly, so `event.seq = …` is a type error rather than a bug that
 * only shows up in a client's transcript.
 *
 * The event types are still `z.infer`-shaped for zod's sake — a schema's output type cannot be
 * rewritten without lying about what `.parse()` returns — so the immutable view of an event is
 * a named alias built with this helper: `ImmutableStoredEvent` and friends in
 * `events/union.ts` and the event modules. {@link DeepReadonly} maps an object type all the
 * way down: arrays become `readonly T[]`, properties become `readonly`, and the mapping
 * recurses through nested objects (a `content` block's fields, a `supersedes` range's).
 */

/**
 * `T`, with every object property and array made readonly, recursively.
 *
 * Primitives pass through unchanged — including the branded ids (`string & { … }`), which must
 * stay assignable to `string` and must not be turned into a mapped object type. Functions pass
 * through too, so applying this to a value that carries one does not break calling it.
 */
export type DeepReadonly<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T
