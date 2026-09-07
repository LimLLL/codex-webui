/** Tests for Codex config inheritance and origin helpers. */
import { describe, expect, it } from 'vitest';
import {
  getConfigPathValue,
  isApprovalReviewerValue,
  isEditableConfigSegment,
  originLabel,
  resolveConfigValue,
} from './codex-config';

describe('codex-config helpers', () => {
  it('reads nested dotted config paths', () => {
    const config = {
      apps: {
        demo: {
          tools: {
            search: { approval_mode: 'prompt' },
          },
        },
      },
    };

    expect(
      getConfigPathValue(config, 'apps.demo.tools.search.approval_mode'),
    ).toBe('prompt');
    expect(getConfigPathValue(config, 'apps.demo.missing')).toBeUndefined();
  });

  it('extracts flat origin metadata for a dotted key path', () => {
    const origins = {
      'apps.demo.approvals_reviewer': {
        name: { type: 'user' },
        version: '1',
      },
    };

    expect(originLabel(origins, 'apps.demo.approvals_reviewer')).toBe('user');
    expect(originLabel(origins, 'apps.demo.default_tools_enabled')).toBeNull();
  });

  it('resolves reviewer inheritance through null local values', () => {
    const config = {
      approvals_reviewer: 'auto_review',
      apps: {
        _default: { approvals_reviewer: null },
        demo: { approvals_reviewer: null },
      },
    };
    const origins = {
      approvals_reviewer: { name: { type: 'user' }, version: '1' },
    };

    expect(
      resolveConfigValue(
        config,
        origins,
        [
          'apps.demo.approvals_reviewer',
          'apps._default.approvals_reviewer',
          'approvals_reviewer',
        ],
        'user',
        isApprovalReviewerValue,
      ),
    ).toEqual({
      value: 'auto_review',
      source: 'user',
      sourceKeyPath: 'approvals_reviewer',
    });
  });

  it('falls back to built-in values when no configured value is present', () => {
    expect(
      resolveConfigValue(
        { apps: { demo: { approvals_reviewer: null } } },
        {},
        ['apps.demo.approvals_reviewer', 'apps._default.approvals_reviewer'],
        'user',
        isApprovalReviewerValue,
      ),
    ).toEqual({
      value: 'user',
      source: 'built-in',
      sourceKeyPath: null,
    });
  });

  it('matches the curated app config segment allowlist shape', () => {
    expect(isEditableConfigSegment('demo-app_1')).toBe(true);
    expect(isEditableConfigSegment('demo.app')).toBe(false);
  });
});
