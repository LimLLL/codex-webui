/** Recovery reads preserve the exact authorization subject and immutable identity. */
import { createTestDatabase } from '../database/database.testing';
import { PendingApprovalsService } from './pending-approvals.service';
import { permissionApprovalFixture } from './pending-approvals.testing';
import { createRequestManager } from './request-owner.testing';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';

it('round-trips permission entries and network-only context without inventing grants', () => {
  const database = createTestDatabase();
  const transport = createRequestManager();
  try {
    const service = new PendingApprovalsService(
      database.db,
      transport.manager,
      new ThreadDeletionRegistryService(),
      new CatalogAdmissionService(),
    );
    service.onModuleInit();
    const request = permissionApprovalFixture();
    transport.receive(request);
    const first = service.listPending(['t1'])[0];
    expect(first.params).toEqual(request.params);
    expect(first.params).not.toHaveProperty('additionalPermissions.network');
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
    transport.receive(withNetwork);
    expect(
      service.listPending(['t1']).find((row) => row.requestId === '18')?.params,
    ).toEqual(withNetwork.params);
    expect(service.readPending(['t1']).requests[0].instanceId).toBe(
      first.instanceId,
    );
  } finally {
    transport.close();
    database.sqlite.close();
  }
});
