/** Checks that SDK generation can preserve complete file-approval subjects and deletion failures. */
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { PendingApprovalsController } from './pending-approvals.controller';
import { PendingApprovalsService } from './pending-approvals.service';

it('exports the full change-set union and the non-snapshot deletion response in OpenAPI', async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [PendingApprovalsController],
    providers: [{ provide: PendingApprovalsService, useValue: {} }],
  }).compile();
  const app = moduleRef.createNestApplication();
  try {
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('pending contract')
        .setVersion('test')
        .build(),
    );
    const schemas = document.components!.schemas!;
    const subject = schemas.FileChangeApprovalSubjectDto as SchemaObject;
    expect(subject.properties?.changes).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/FileUpdateChangeDto' },
    });
    const change = schemas.FileUpdateChangeDto as SchemaObject;
    expect(change.required).toEqual(
      expect.arrayContaining(['path', 'kind', 'diff']),
    );
    expect(change.properties?.kind).toHaveProperty('oneOf', [
      { $ref: '#/components/schemas/PatchChangeKindAddDto' },
      { $ref: '#/components/schemas/PatchChangeKindDeleteDto' },
      { $ref: '#/components/schemas/PatchChangeKindUpdateDto' },
    ]);
    expect(
      (schemas.PatchChangeKindUpdateDto as SchemaObject).properties,
    ).toHaveProperty('move_path');
    expect(
      (schemas.PendingServerRequestDto as SchemaObject).properties
        ?.reviewSubject,
    ).toHaveProperty('nullable', true);
    expect(
      (schemas.PendingServerRequestsResponseDto as SchemaObject).required,
    ).toContain('generation');
    expect(document.paths['/pending-approvals'].get?.responses).toHaveProperty(
      '409',
    );
  } finally {
    await app.close();
  }
});
