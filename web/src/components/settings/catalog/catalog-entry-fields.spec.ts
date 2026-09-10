/** Field derivation and the absent/null/empty distinctions upstream relies on. */
import { describe, expect, it } from 'vitest';
import {
  applyField,
  catalogFields,
  fieldText,
  placeEntry,
} from './catalog-entry-fields';
import type { CatalogEntry } from './use-catalog-draft';

const template: CatalogEntry = {
  slug: 'gpt-x',
  display_name: 'GPT X',
  description: 'Something',
  visibility: 'list',
  priority: 1,
  context_window: 272_000,
  max_context_window: 872_000,
  supported_in_api: true,
  default_verbosity: null,
  model_messages: { instructions_template: 'Be useful.' },
  a_field_this_app_has_never_heard_of: 'keep me',
};

describe('catalogFields', () => {
  it('derives fields from the template so unknown upstream keys stay editable', () => {
    const keys = catalogFields({ slug: 'custom' }, template).map((f) => f.key);
    expect(keys).toContain('a_field_this_app_has_never_heard_of');
    expect(keys).toContain('model_messages');
  });

  it('leads with the identity and context fields', () => {
    const keys = catalogFields(template, template).map((f) => f.key);
    expect(keys.slice(0, 3)).toEqual(['slug', 'display_name', 'description']);
    expect(keys).toContain('max_context_window');
  });

  it('types fields from their values, including nested objects', () => {
    const fields = catalogFields(template, template);
    const kind = (key: string) => fields.find((f) => f.key === key)?.kind;
    expect(kind('priority')).toBe('number');
    expect(kind('supported_in_api')).toBe('boolean');
    expect(kind('slug')).toBe('string');
    expect(kind('model_messages')).toBe('json');
  });

  it('marks a template null as nullable so it can be cleared, not dropped', () => {
    const fields = catalogFields({ slug: 'custom' }, template);
    expect(fields.find((f) => f.key === 'default_verbosity')?.nullable).toBe(
      true,
    );
  });
});

describe('applyField', () => {
  const field = (key: string, entry: CatalogEntry = template) =>
    catalogFields(entry, template).find((f) => f.key === key)!;

  it('clears a nullable field to null rather than removing it', () => {
    const result = applyField(template, field('default_verbosity'), '');
    expect(result).toEqual({
      entry: expect.objectContaining({ default_verbosity: null }),
    });
  });

  it('removes a non-nullable field so the schema default applies', () => {
    const result = applyField(template, field('description'), '');
    expect('entry' in result && 'description' in result.entry).toBe(false);
  });

  it('never writes an empty string, which upstream treats as its own value', () => {
    const result = applyField(template, field('display_name'), '   ');
    expect('entry' in result && result.entry.display_name).toBeUndefined();
  });

  it('rejects unparseable numbers and JSON instead of corrupting the entry', () => {
    expect(applyField(template, field('priority'), 'abc')).toHaveProperty(
      'error',
    );
    expect(
      applyField(template, field('model_messages'), '{not json'),
    ).toHaveProperty('error');
  });

  it('round trips a nested object through the JSON editor unchanged', () => {
    const messages = field('model_messages');
    const text = fieldText(template, messages);
    const result = applyField({ slug: 'custom' }, messages, text);
    expect('entry' in result && result.entry.model_messages).toEqual(
      template.model_messages,
    );
  });

  it('keeps other fields untouched when one is edited', () => {
    const result = applyField(template, field('slug'), 'renamed');
    expect('entry' in result && result.entry).toMatchObject({
      slug: 'renamed',
      a_field_this_app_has_never_heard_of: 'keep me',
      model_messages: template.model_messages,
    });
  });
});

describe('placeEntry', () => {
  const models: CatalogEntry[] = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];

  it('replaces the edited row even though the list was reparsed since', () => {
    // The dialog holds an entry from an earlier render; the document is parsed
    // fresh every render, so identity lookup would miss and drop the edit.
    const result = placeEntry(models, 'b', { slug: 'b', priority: 9 });
    expect('models' in result && result.models).toEqual([
      { slug: 'a' },
      { slug: 'b', priority: 9 },
      { slug: 'c' },
    ]);
  });

  it('lands a rename on the original row instead of appending a copy', () => {
    const result = placeEntry(models, 'b', { slug: 'b-renamed' });
    expect('models' in result && result.models).toEqual([
      { slug: 'a' },
      { slug: 'b-renamed' },
      { slug: 'c' },
    ]);
  });

  it('reports a conflict when the edited entry was removed meanwhile', () => {
    expect(placeEntry(models, 'gone', { slug: 'gone' })).toEqual({
      missing: 'gone',
    });
  });

  it('appends a new entry and overwrites an existing slug when adding', () => {
    expect(placeEntry(models, null, { slug: 'd' })).toEqual({
      models: [...models, { slug: 'd' }],
    });
    const result = placeEntry(models, null, { slug: 'b', priority: 1 });
    expect('models' in result && result.models).toEqual([
      { slug: 'a' },
      { slug: 'b', priority: 1 },
      { slug: 'c' },
    ]);
  });
});
