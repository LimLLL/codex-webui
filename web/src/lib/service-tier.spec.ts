/** Prevents unsupported or absent tiers from being mislabeled as Standard. */
import { resolveServiceTier } from './service-tier';
import { it, expect } from 'vitest';

const model = { serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }], defaultServiceTier: 'priority' };

it('filters unsupported configured tiers without falling back to the default', () => {
  expect(resolveServiceTier('unknown', model)).toBeNull();
  expect(resolveServiceTier('priority', { ...model, serviceTiers: [] })).toBeNull();
});
it('preserves supported local choices and the explicit standard choice', () => {
  expect(resolveServiceTier('priority', model)).toBe('priority');
  expect(resolveServiceTier('default', model)).toBe('default');
  expect(resolveServiceTier(null, model)).toBe('priority');
  expect(resolveServiceTier(null, { ...model, defaultServiceTier: 'unknown' })).toBeNull();
});
