/**
 * The application currently ships without Jasmine/Karma packages, but these
 * specs are intentionally ready for the Angular Jasmine runner. Keep the
 * declarations local so production code does not depend on a test framework.
 */
interface JasmineSpecMatchers {
  not: JasmineSpecMatchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeCloseTo(expected: number, precision?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeNull(): void;
  toBeTrue(): void;
  toBeFalse(): void;
}

declare function describe(description: string, specDefinitions: () => void): void;
declare function it(description: string, testFunction: () => void): void;
declare function expect(actual: unknown): JasmineSpecMatchers;
