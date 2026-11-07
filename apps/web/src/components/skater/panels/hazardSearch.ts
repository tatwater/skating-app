import { z } from 'zod';

/**
 * `/hazard/$id`'s search (D242): `?action=confirm` is the old link grammar, kept — the landing target
 * of an on-ice notification's "still there?" tap (D54), which opens the card on its verdicts. Any
 * other value degrades to the plain card instead of an error.
 */
export const hazardSearchSchema = z.object({
  action: z
    .literal('confirm')
    .optional()
    .catch(() => undefined),
});

export type HazardSearch = z.infer<typeof hazardSearchSchema>;
