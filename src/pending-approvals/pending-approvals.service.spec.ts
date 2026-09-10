import { createTestDatabase } from '../database/database.testing';
import { PendingApprovalsService } from './pending-approvals.service';
import { permissionApprovalFixture } from './pending-approvals.testing';

describe('approval recovery payload preservation', () => {
  it('round-trips permission entries and network-only context without inventing network grants', () => {
    const { db, sqlite } = createTestDatabase();
    try {
      const service = new PendingApprovalsService(
        db,
        {
          getGeneration: () => 1,
          addLifecycleListener: vi.fn(),
        } as never,
        { assertMutable: vi.fn() } as never,
        { assertOpen: vi.fn() } as never,
      );
      const request = permissionApprovalFixture();
      service.recordServerRequest(request);
      expect(service.listPending(['t1'])[0].params).toEqual(request.params);
      expect(service.listPending(['t1'])[0].params).not.toHaveProperty(
        'additionalPermissions.network',
      );

      const withNetwork = {
        ...request,
        id: 18,
        params: {
          ...request.params,
          additionalPermissions: {
            ...request.params.additionalPermissions,
            network: { enabled: true },
          },
        },
      };
      service.recordServerRequest(withNetwork);
      expect(
        service.listPending(['t1']).find((row) => row.requestId === '18')
          ?.params,
      ).toEqual(withNetwork.params);
    } finally {
      sqlite.close();
    }
  });
});
