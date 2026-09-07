/** Guards the catalog-copy fallback against i18next rewriting upstream text. */
import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { catalogCopy } from './catalog-copy';

describe('catalogCopy', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('translates catalog strings we have localized', () => {
    expect(catalogCopy('Fast responses with lighter reasoning')).toBe(
      '轻量推理，响应最快',
    );
  });

  it('returns untranslated catalog copy verbatim', () => {
    const upstream = 'A brand new model that ships next release';
    expect(catalogCopy(upstream)).toBe(upstream);
  });

  it('does not resolve i18next nesting inside untranslated copy', () => {
    // A bare `t(value)` returns "Has Model nesting" here: i18next applies
    // nesting even when the key is missing, quietly rewriting catalog text.
    const upstream = 'Has $t(Model) nesting';
    expect(catalogCopy(upstream)).toBe(upstream);
  });

  it('leaves catalog copy containing separator characters intact', () => {
    // Real tier copy, and the reason no id-keyed dictionary is needed.
    expect(catalogCopy('1.5x speed, increased usage')).toBe(
      '1.5 倍速度，用量消耗更高',
    );
  });
});
