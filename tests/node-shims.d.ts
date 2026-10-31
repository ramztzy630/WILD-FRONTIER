/**
 * Minimal type declarations for the node built-ins used by the unit tests.
 * Avoids adding @types/node as a dependency (ARCHITECTURE.md §1.3: three,
 * vite, typescript, @types/three only). Extend when a test needs more.
 */

declare module "node:test" {
  type TestFn = (t: unknown) => void | Promise<void>;
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: TestFn): void;
  export function test(name: string, fn: TestFn): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
