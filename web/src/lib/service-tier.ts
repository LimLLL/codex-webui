/** Local tier resolution mirrors the pinned reference client's support filter. */
import type { ModelDto } from '@/generated/api';

/**
 * Resolves a lifecycle-seeded or explicitly selected tier against this model.
 * An unsupported configured tier becomes absent, never the catalog default or
 * Standard. This is local display state, not cross-client synchronization.
 */
export function resolveServiceTier(
  configured: string | null | undefined,
  model: Pick<ModelDto, 'serviceTiers' | 'defaultServiceTier'> | undefined,
): string | null {
  if (configured === 'default') return configured;
  const candidate = configured ?? model?.defaultServiceTier;
  return candidate && model?.serviceTiers.some((tier) => tier.id === candidate)
    ? candidate : null;
}
