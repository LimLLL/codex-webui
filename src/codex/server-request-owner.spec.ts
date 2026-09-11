/** Liveness, identity, and exception behavior at the open-world RPC boundary. */
import {
  ServerRequestOwner,
  type OwnedServerRequest,
  type ServerRequestRetirement,
} from './server-request-owner';
import { validateHumanRequest } from '../pending-approvals/human-request-contract';

describe('server request ownership', () => {
  const request = {
    id: 0,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't', turnId: 'turn', itemId: 'item', command: 'pwd' },
  };
  let send: ReturnType<typeof vi.fn<(message: unknown) => void>>;
  let retired: ReturnType<
    typeof vi.fn<(event: ServerRequestRetirement) => void>
  >;
  let owner: ServerRequestOwner;
  beforeEach(() => {
    send = vi.fn();
    retired = vi.fn();
    owner = new ServerRequestOwner(send, retired, vi.fn());
  });

  it.each([
    'future/unknown',
    'currentTime/read',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'item/tool/call',
    'applyPatchApproval',
    'execCommandApproval',
  ])('explicitly refuses %s without requiring an observer', (method) => {
    owner.receive({ ...request, method });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      id: 0,
      error: {
        code: expect.any(Number) as unknown,
        message: expect.stringContaining('WebUI') as unknown,
      },
    });
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });
  it('refuses a known request when no admission handler claims it', () => {
    owner.receive(request);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) as unknown }),
    );
  });
  it('turns malformed payloads and admission exceptions into attributable errors', () => {
    owner.setHandler((owned) => {
      validateHumanRequest(owned.request);
      throw new Error('private database contents');
    });
    owner.receive({ ...request, params: null });
    owner.receive({ ...request, id: 1 });
    expect(
      send.mock.calls.map(
        ([value]) => (value as { error: { code: number } }).error.code,
      ),
    ).toEqual([-32602, -32603]);
    expect(JSON.stringify(send.mock.calls)).not.toContain('private database');
  });
  it('retains multiple human requests while another request is refused immediately', () => {
    const held: OwnedServerRequest[] = [];
    owner.setHandler((owned) => {
      held.push(owned);
      return true;
    });
    owner.receive(request);
    owner.receive({ ...request, id: 1 });
    owner.receive({ ...request, id: 2, method: 'unknown' });
    expect(held.every((entry) => entry.isPending())).toBe(true);
    held[0].respond({ decision: 'decline' });
    expect(() => held[0].respond({ decision: 'accept' })).toThrow(
      'no longer pending',
    );
    expect(held[1].isPending()).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not mint or answer a duplicate after resolution or interruption', () => {
    const handler = vi.fn(() => true);
    owner.setHandler(handler);
    owner.receive(request);
    owner.observe('serverRequest/resolved', { requestId: 0 });
    owner.receive(request);
    expect(handler).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
  it('cannot send an old answer through a replacement connection', () => {
    let held!: OwnedServerRequest;
    owner.setHandler((entry) => {
      held = entry;
      return true;
    });
    owner.receive(request);
    owner.close();
    const replacement = new ServerRequestOwner(send, retired, vi.fn());
    replacement.setHandler(() => true);
    replacement.receive(request);
    expect(() => held.respond({ decision: 'accept' })).toThrow(
      'no longer pending',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('never retries a response whose transport write failed ambiguously', () => {
    let held!: OwnedServerRequest;
    owner.setHandler((entry) => {
      held = entry;
      return true;
    });
    owner.receive(request);
    send.mockImplementation(() => {
      throw new Error('write failed');
    });
    expect(() => held.respond({ decision: 'accept' })).toThrow(
      'could not be confirmed',
    );
    expect(() => held.respond({ decision: 'accept' })).toThrow(
      'no longer pending',
    );
    expect(send).toHaveBeenCalledOnce();
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });
});
