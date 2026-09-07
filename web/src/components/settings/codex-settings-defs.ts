/** Field definitions and draft parsing for structured Codex config settings. */
import type { ConfigEditDto } from '@/generated/api/types.gen';

type FieldControl = 'input' | 'number' | 'select' | 'textarea';

/** Curated structured editor field definition. */
export interface FieldDef {
  /** Dotted config key path accepted by the backend allowlist. */
  key: ConfigEditDto['keyPath'];
  /** User-facing label. */
  label: string;
  /** Group heading. */
  group: string;
  /** Control kind used to edit the value. */
  control: FieldControl;
  /** Static select options, when the field is a protocol enum. */
  options?: readonly string[];
  /** Optional concise field description. */
  description?: string;
}

/** Curated top-level config fields shown in the structured editor. */
export const FIELD_DEFS: FieldDef[] = [
  {
    key: 'profile',
    label: 'Active Profile',
    group: 'Profile',
    control: 'select',
    options: [], // populated dynamically from config.profiles
    description: 'Switch active configuration profile',
  },
  {
    key: 'model',
    label: 'Model',
    group: 'Model',
    control: 'input',
    description: 'Default model name',
  },
  {
    key: 'review_model',
    label: 'Review Model',
    group: 'Model',
    control: 'input',
    description: 'Model used for code review',
  },
  {
    key: 'model_provider',
    label: 'Model Provider',
    group: 'Model',
    control: 'input',
    description: 'Provider identifier (e.g. openai, anthropic)',
  },
  {
    key: 'model_context_window',
    label: 'Context Window',
    group: 'Model',
    control: 'number',
    description: 'Maximum context window size in tokens',
  },
  {
    key: 'model_auto_compact_token_limit',
    label: 'Auto Compact Limit',
    group: 'Model',
    control: 'number',
    description: 'Token threshold for automatic context compaction',
  },
  {
    key: 'instructions',
    label: 'Instructions',
    group: 'Instructions',
    control: 'textarea',
    description: 'User-level instructions for the model',
  },
  {
    key: 'developer_instructions',
    label: 'Developer Instructions',
    group: 'Instructions',
    control: 'textarea',
    description: 'Developer-level behavior instructions',
  },
  {
    key: 'compact_prompt',
    label: 'Compact Prompt',
    group: 'Instructions',
    control: 'textarea',
    description: 'Custom prompt used during context compaction',
  },
  {
    key: 'model_reasoning_effort',
    label: 'Reasoning Effort',
    group: 'Reasoning',
    control: 'select',
    // Kept in sync with the backend's REASONING_EFFORT_VALUES. Unlike service
    // tiers this really is a fixed enum, but it still has to be updated on a
    // CLI bump — 0.153.2 added `max` and `ultra`.
    options: [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ],
  },
  {
    key: 'model_reasoning_summary',
    label: 'Reasoning Summary',
    group: 'Reasoning',
    control: 'select',
    options: ['auto', 'concise', 'detailed', 'none'],
  },
  {
    key: 'model_verbosity',
    label: 'Verbosity',
    group: 'Reasoning',
    control: 'select',
    options: ['low', 'medium', 'high'],
  },
  {
    key: 'web_search',
    label: 'Web Search',
    group: 'Tools',
    control: 'select',
    options: ['disabled', 'cached', 'live'],
  },
  {
    key: 'service_tier',
    label: 'Service Tier',
    group: 'Advanced',
    control: 'select',
    // Options are supplied at render time from the model catalog; see
    // `serviceTierOptions`. No static list can be correct here.
  },
];

/** Group names in structured editor display order. */
export const GROUP_ORDER = [
  'Profile',
  'Model',
  'Instructions',
  'Reasoning',
  'Tools',
  'Advanced',
];

type ParseResult =
  | { ok: true; value: ConfigEditDto['value'] }
  | { ok: false; error: string };

/** Converts a structured editor draft string into the JSON value to write. */
export function stringToConfigValue(key: string, raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Value cannot be empty' };
  }

  if (
    key === 'model_context_window' ||
    key === 'model_auto_compact_token_limit'
  ) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return { ok: false, error: 'Value must be a valid number' };
    }
    return { ok: true, value: n };
  }

  return { ok: true, value: trimmed };
}
