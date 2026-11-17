// Types for the validator, so the repository's own tests can use it under `tsc`. The validator
// itself is plain JavaScript on purpose: the conformance suite imports nothing from `src/`, and a
// suite that shared the implementation's types would be checking that it agrees with itself.

/** Every problem with a value, as paths into it. Empty means it validates. */
export function validate(
  schema: unknown,
  value: unknown,
  root?: unknown,
  at?: string,
  docs?: Record<string, unknown>,
): string[];

/** Loads every schema in a directory, keyed by file name, ready to pass as `docs`. */
export function load(
  dir: string,
  read: { names(dir: string): string[]; text(path: string): string },
): Record<string, unknown>;
