import { CodexRpcError } from '../codex/codex-errors';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { ThreadHistoryService } from './thread-history.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';

describe('ThreadResumeRegistryService', () => {
  const mockHistory = {
    resumeMetadataFirst: vi.fn(),
    readThreadMetadata: vi.fn(),
    listTurns: vi.fn(),
  };
  const mockManager = {
    addLifecycleListener: vi.fn(),
    getGeneration: vi.fn(),
  };
  let service: ThreadResumeRegistryService;

  beforeEach(() => {
    Object.values(mockHistory).forEach((mock) => mock.mockReset());
    Object.values(mockManager).forEach((mock) => mock.mockReset());
    mockManager.getGeneration.mockReturnValue(1);
    service = new ThreadResumeRegistryService(
      mockHistory as unknown as ThreadHistoryService,
      mockManager as unknown as CodexProcessManager,
    );
  });

  it('opens with metadata-first resume and an initial turn page', async () => {
    mockHistory.resumeMetadataFirst.mockResolvedValue({
      thread: makeThread('t1'),
      model: 'gpt-5',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: '/tmp',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { mode: 'read-only' },
      reasoningEffort: null,
      initialTurnsPage: {
        data: [],
        nextCursor: 'older',
        backwardsCursor: null,
      },
      turnsBackwardsCursor: 'newer',
      itemsBackwardsCursor: null,
    });

    await expect(service.ensureOpened('t1', 12)).resolves.toMatchObject({
      mode: 'writable',
      ownership: 'acquired',
      thread: { id: 't1', turns: [] },
      initialTurnsPage: { nextCursor: 'older' },
      turnsBackwardsCursor: 'newer',
    });
    expect(mockHistory.resumeMetadataFirst).toHaveBeenCalledWith({
      threadId: 't1',
      initialTurnsLimit: 12,
      itemsView: 'summary',
    });
  });

  it('dedupes concurrent ownership attempts per thread generation', async () => {
    mockHistory.resumeMetadataFirst.mockResolvedValue({
      thread: makeThread('t1'),
      model: 'gpt-5',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: '/tmp',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { mode: 'read-only' },
      reasoningEffort: null,
      initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
    });

    const [first, second] = await Promise.all([
      service.ensureOpened('t1'),
      service.ensureOpened('t1'),
    ]);

    expect(first).toBe(second);
    expect(mockHistory.resumeMetadataFirst).toHaveBeenCalledTimes(1);
  });

  it('returns read-only open when another writer owns the thread', async () => {
    // Wording taken verbatim from the pinned app-server, not invented: this
    // downgrade path is only correct if it recognises the message the server
    // actually sends.
    mockHistory.resumeMetadataFirst.mockRejectedValue(
      new CodexRpcError({
        code: -32600,
        message: 'thread t1 already has an active writer',
      }),
    );
    mockHistory.readThreadMetadata.mockResolvedValue({
      thread: makeThread('t1'),
    });
    mockHistory.listTurns.mockResolvedValue({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });

    await expect(service.ensureOpened('t1')).resolves.toMatchObject({
      mode: 'readOnly',
      ownership: 'refused',
      ownershipRefusalMessage:
        'RPC error -32600: thread t1 already has an active writer',
      thread: { id: 't1', turns: [] },
    });
  });

  it('does not downgrade an unrelated failure to read-only', async () => {
    // A real failure misread as an ownership conflict is worse than an
    // unhandled error: the user gets a conversation they cannot type into and
    // a banner blaming another client that does not exist.
    mockHistory.resumeMetadataFirst.mockRejectedValue(
      new CodexRpcError({
        code: -32600,
        message: 'thread t1 owner record is corrupt',
      }),
    );

    await expect(service.ensureOpened('t1')).rejects.toThrow(
      'owner record is corrupt',
    );
    expect(mockHistory.readThreadMetadata).not.toHaveBeenCalled();
  });
});

function makeThread(id: string) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    path: null,
    cwd: '/tmp',
    cliVersion: '0.149.1',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [{ id: 'turn', status: 'completed' }],
  };
}
