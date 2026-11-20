// Minimal ambient types for the Node built-ins src/usage.test.ts imports, so `npx tsc -p .`
// stays clean without adding @types/node as a dependency (this repo has none, by design — no
// package.json, no build step). Only the surface the pure suite uses is declared; node:test
// and node:assert provide far more. If the repo ever gains @types/node, delete this file.

declare module 'node:test' {
  export function describe(name: string, fn: () => void | Promise<void>): void
  export function it(name: string, fn: () => void | Promise<void>): void
  export function it(name: string, options: unknown, fn: () => void | Promise<void>): void
  export function test(name: string, fn: () => void | Promise<void>): void
}

declare module 'node:assert' {
  export const strict: {
    equal(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    match(string: string, regexp: RegExp, message?: string): void
    doesNotMatch(string: string, regexp: RegExp, message?: string): void
    ok(value: unknown, message?: string): asserts value
  }
}

declare module 'node:fs/promises' {
  /** Only the surface src/worker.ts uses: reading the auto-discovered auth files as text. */
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:os' {
  /** Only the surface src/worker.ts uses: resolving `~` for the auth-file paths. */
  export function homedir(): string
}
