/**
 * @fileoverview Growth check for a function over caller-sized text. Runs the
 * function on inputs that double in size across a 64× span, measuring the
 * calling thread's CPU time (never wall clock), and fails on super-linear growth
 * or an absolute bound breach at any size.
 * @module tests/helpers/cpu-timing
 */

import { expect } from 'vitest';

/** Smallest input size; doubled six times to 64× (64,000 characters), below Bun's ~80k regex mode switch. */
const BASE_CHARS = 1000;
const DOUBLINGS = 6;
/**
 * Characters processed at each size, split into `ceil(CHARS_PER_SIZE / length)`
 * runs. A fixed budget holds every size to the same amount of work, so the
 * whole sweep stays far inside the test timeout on a loaded machine, while the
 * smallest size still repeats enough to measure well above timer resolution.
 */
const CHARS_PER_SIZE = 256_000;
/** A linear function grows 64× per run across the span; quadratic would be 4,096×. */
const MAX_SPAN_RATIO = 256;
/** CPU microseconds allowed for all runs at one size, CHARS_PER_SIZE characters of work. */
const MAX_CPU_US_PER_SIZE = 1_000_000;
/**
 * Measurements per size; the fastest counts. A cheap function's whole budget
 * can cost tens of microseconds, where one cache-cold stall or GC slice would
 * read as growth — noise only ever adds time, so the minimum filters it.
 */
const TRIALS = 3;

function cpuMicros(reps: number, run: () => void): number {
  const start = process.threadCpuUsage();
  for (let i = 0; i < reps; i++) run();
  const used = process.threadCpuUsage(start);
  return used.user + used.system;
}

/**
 * Assert `fn` stays linear on `shape(n)`, an input of about `n` characters.
 * Each size is checked against the absolute bound before the next is built;
 * the span ratio compares CPU time per run at the largest and smallest sizes.
 */
export function expectLinearGrowth(fn: (input: string) => unknown, shape: (n: number) => string) {
  const perRunMicros: number[] = [];
  for (let step = 0; step <= DOUBLINGS; step++) {
    const input = shape(BASE_CHARS * 2 ** step);
    // Warm on every input, outside the measurement: the first call carries JIT
    // compilation and flattening the freshly built string, a one-time O(n) cost
    // that, spread over the few runs a large size gets, would read as growth.
    fn(input);
    const reps = Math.ceil(CHARS_PER_SIZE / input.length);
    let fastest = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < TRIALS; trial++) {
      const micros = cpuMicros(reps, () => fn(input));
      expect(micros, `CPU time for ${reps} runs at ${input.length} chars`).toBeLessThan(
        MAX_CPU_US_PER_SIZE,
      );
      fastest = Math.min(fastest, micros);
    }
    // Floored at the timer's 1 µs resolution, so a budget too fast to register
    // never divides the span ratio by zero.
    perRunMicros.push(Math.max(fastest, 1) / reps);
  }
  expect(
    perRunMicros.at(-1)! / perRunMicros[0]!,
    `per-run growth across the 64× span: ${perRunMicros.map((us) => us.toFixed(2)).join(', ')} µs`,
  ).toBeLessThan(MAX_SPAN_RATIO);
}

/**
 * The two line-break shapes every timing suite carries, each repeated to about
 * `n` characters: one long line ending in a break, and breaks throughout.
 */
export const LINE_BREAK_SHAPES: ReadonlyArray<[name: string, shape: (n: number) => string]> = [
  ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
  ['breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
];
