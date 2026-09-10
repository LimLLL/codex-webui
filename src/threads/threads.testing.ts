/**
 * Thread fixtures for specs.
 *
 * `v2.Thread` gains required fields on every app-server upgrade, and each spec
 * that hand-rolled its own literal broke separately — the 0.153.2 bump added
 * `historyMode`, `model` and `reasoningEffort`. One factory means a protocol
 * migration is a single edit here, and it stays fully typed rather than being
 * silenced with a cast that would also hide genuinely wrong fixtures.
 */
import type { v2 } from '../codex/codex-schema';

/**
 * Builds a complete thread with sensible idle defaults.
 *
 * @param overrides - Fields this test actually cares about.
 * @returns A `v2.Thread` satisfying the pinned schema.
 */
export function makeThreadFixture(
  overrides: Partial<v2.Thread> = {},
): v2.Thread {
  return {
    id: 'thread',
    sessionId: 'session',
    forkedFromId: null,
    parentThreadId: null,
    preview: 'thread',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    historyMode: 'paginated',
    status: { type: 'idle' },
    path: null,
    cwd: '/tmp',
    cliVersion: '0.154.0',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    model: null,
    reasoningEffort: null,
    turns: [],
    ...overrides,
  };
}
