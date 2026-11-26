import type { z } from 'zod';
import { ProviderError } from './errors.js';

/** Validates an external payload; the error lists the failing fields, never the payload itself. */
export function parseResponse<S extends z.ZodType>(source: string, schema: S, payload: unknown, what: string): z.output<S> {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new ProviderError(source, 'invalid-response', `unexpected ${what}: ${issues}`);
}
