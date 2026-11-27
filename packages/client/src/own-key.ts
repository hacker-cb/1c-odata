// packages/client/src/own-key.ts

/**
 * The one rule for writing a key that comes from outside data — a response
 * body, a write payload, an EDMX name — into a dictionary: it becomes the
 * dictionary's own field, whatever it is called.
 *
 * Plain assignment does that for every name but `__proto__`, the one accessor
 * `Object.prototype` carries: `out['__proto__'] = v` replaces the prototype of
 * `out` (or, for a non-object `v`, does nothing) instead of adding a field. So
 * that key alone is defined, as an ordinary enumerable data property, and the
 * dictionary keeps its own prototype — a parsed row is still a plain object
 * (`row.hasOwnProperty` works), only now with the field it was sent.
 *
 * For a dictionary that is a plain object (`{}`), whose only inherited
 * accessor is `__proto__` — every caller builds one.
 *
 * Reached by `@1c-odata/metadata` through `@1c-odata/client/internal`, so it
 * carries no internal tag: `stripInternal` would drop it from that
 * entrypoint's types.
 */
export function setOwn<T>(dict: Record<string, T>, key: string, value: T): void {
  if (key === '__proto__') {
    Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    dict[key] = value
  }
}
