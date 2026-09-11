/** Exercises user decisions and nullable anchoring through the real browser store. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { InteractionPresentationDto } from '@/generated/api';
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { parseApprovalRequest } from '@/lib/approval-parsers';
import { ingestRequestFailure } from '@/lib/server-request-failures';
import { retirePendingRequest } from '@/lib/pending-approvals-sync';
import { StoredInteractionCard } from './interaction-card';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/generated/api/sdk.gen', () => ({ pendingApprovalsRespond: vi.fn(), pendingApprovalsListPending: vi.fn() }));
const initial = useTimelineStore.getState();
const respond = vi.mocked(pendingApprovalsRespond);

/** A safe projection supplied by the backend, independent of raw upstream schemas. */
function presentation(overrides: Partial<InteractionPresentationDto>): InteractionPresentationDto {
  return { kind: 'elicitation', supported: true, unsupportedReason: null, message: 'Please choose',
    serverName: 'Example MCP', cwd: null, environmentId: null, url: null, permissions: [], fields: [], ...overrides };
}

/** Routes a live envelope through the shared parser and request-only timeline path. */
function show(prompt: InteractionPresentationDto) {
  const request = parseApprovalRequest({ requestId: '0', instanceId: 'proposal', generation: 1,
    method: prompt.kind === 'permissions' ? 'item/permissions/requestApproval' : 'mcpServer/elicitation/request',
    params: { threadId: 't', turnId: null }, presentation: prompt })!;
  const store = useTimelineStore.getState();
  store.selectThread('t'); store.addApprovalForThread('t', request);
  render(<StoredInteractionCard requestId="0" instanceId="proposal" />);
}

beforeEach(() => {
  useTimelineStore.setState(initial, true); respond.mockReset();
  respond.mockResolvedValue({ data: { status: 'submitted' } } as Awaited<ReturnType<typeof pendingApprovalsRespond<true>>>);
});

it('shows every grant/restriction and sends only selected IDs with explicit session scope', async () => {
  show(presentation({ kind: 'permissions', serverName: null, cwd: 'workspace', permissions: [
    { id: 'entry:0', label: 'scope: project_roots / src', access: 'write', required: false },
    { id: 'entry:1', label: 'glob: **/*.secret', access: 'deny', required: true },
    { id: 'network', label: 'Network access', access: 'network', required: false },
  ] }));
  expect(screen.getByRole('checkbox', { name: /secret/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Grant selected' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /project_roots/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Keep these grants/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Grant selected' })); });
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ path: { requestId: '0' }, body: {
    instanceId: 'proposal', result: { selected: ['entry:0'], scope: 'session' },
  } }));
  // The answered card keeps both halves: the choice this user made, which is
  // certain, and the delivery state, which only app-server can confirm.
  expect(screen.getByText(/Accepted for session · Decision submitted/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Grant selected' })).toBeNull();
});

it('renders unsupported forms with nullable turn anchoring and only negative actions', async () => {
  show(presentation({ supported: false, unsupportedReason: 'This client cannot render these semantics.' }));
  expect(useTimelineStore.getState().timeline).toEqual([{ kind: 'interaction', requestId: '0', instanceId: 'proposal' }]);
  expect(screen.getByRole('alert')).toHaveTextContent('cannot render');
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { instanceId: 'proposal', result: { action: 'cancel', content: null } } }));
});

it.each(['submitted', 'resolved'] as const)(
  'retains this browser’s choice when resolution beats the HTTP %s acknowledgement',
  async (status) => {
    respond.mockImplementationOnce(async () => {
      retirePendingRequest({ threadId: 't', requestId: '0', instanceId: 'proposal', generation: 1, status: 'resolved' });
      return { data: { status } } as Awaited<ReturnType<typeof pendingApprovalsRespond<true>>>;
    });
    show(presentation({ url: 'https://example.test/auth' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(useTimelineStore.getState().approvals['0']).toMatchObject({ status: 'resolved', decision: 'accepted' });
    expect(screen.getByText('Accepted')).toBeTruthy();
    expect(screen.queryByText('Decision submitted')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  },
);

it('keeps the submitted choice visible when delivery later fails', async () => {
  show(presentation({ url: 'https://example.test/auth' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
  act(() => retirePendingRequest({ threadId: 't', requestId: '0', instanceId: 'proposal', generation: 1, status: 'failed' }));
  expect(screen.getByText('Accepted · Delivery unconfirmed')).toBeTruthy();
});

it('submits false and zero as real answers rather than omitting them', async () => {
  show(presentation({ fields: [
    { name: 'enabled', title: 'Enabled', description: '', type: 'boolean', required: true },
    { name: 'count', title: 'Count', description: '', type: 'integer', required: true, minimum: 0 },
  ] }));
  fireEvent.change(screen.getByRole('combobox', { name: /Enabled/ }), { target: { value: 'false' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /Count/ }), { target: { value: '0' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Submit' }).closest('form')!); });
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { instanceId: 'proposal', result: { action: 'accept', content: { enabled: false, count: 0 } } } }));
});

it('opening an elicitation URL does not answer the request', async () => {
  show(presentation({ url: 'https://example.test/auth' }));
  fireEvent.click(screen.getByRole('link'));
  expect(respond).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { instanceId: 'proposal', result: { action: 'accept', content: null } } }));
});

it('retains an attributable refusal without ending the turn or duplicating it on recovery', () => {
  const store = useTimelineStore.getState(); store.selectThread('t');
  store.setLoadingForThread('t', true); store.setActiveTurnIdForThread('t', 'turn');
  const failure = { instanceId: 'refused', threadId: 't', turnId: 'turn', message: 'This WebUI cannot handle this request.' };
  ingestRequestFailure(failure); ingestRequestFailure(failure);
  const runtime = store.getThreadRuntime('t')!;
  expect(runtime.loading).toBe(true); expect(runtime.activeTurnId).toBe('turn');
  expect(runtime.timeline.filter((entry) => entry.kind === 'system')).toHaveLength(1);
});
