/** User-visible distinctions between legacy and structured terminal failures. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/i18n';
import { TurnFailureCard } from './turn-failure-card';

describe('TurnFailureCard', () => {
  it('renders a legacy message without an empty misalignment section', () => {
    render(
      <TurnFailureCard
        failure={{
          turnId: 'turn-1',
          message: 'legacy failure',
          errorCategory: null,
          additionalDetails: null,
          misalignmentErrorType: null,
          misalignmentExplanation: null,
        }}
      />,
    );

    expect(screen.getByText('legacy failure')).toBeTruthy();
    expect(
      screen.queryByText('Request alignment explanation'),
    ).toBeNull();
  });

  it('shows persisted misalignment classification and explanation without controls', () => {
    render(
      <TurnFailureCard
        failure={{
          turnId: 'turn-1',
          message: 'blocked',
          errorCategory: 'misalignmentPolicyViolation',
          additionalDetails: 'policy detail',
          misalignmentErrorType: 'policy_conflict',
          misalignmentExplanation: 'explanation for the user',
        }}
      />,
    );

    expect(screen.getByText('policy_conflict')).toBeTruthy();
    expect(screen.getByText('explanation for the user')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
