/** Verifies that handwritten Codex v2 OpenAPI mirrors match the pinned schema. */
import { Controller, Get, type INestApplication } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  CODEX_ERROR_INFO_STRING_VALUES,
  CODEX_V2_EXTRA_MODELS,
  TurnDto,
} from './index';

interface ContractSchema {
  $ref?: string;
  allOf?: ContractSchema[];
  enum?: string[];
  items?: ContractSchema;
  nullable?: boolean;
  oneOf?: ContractSchema[];
  properties?: Record<string, ContractSchema>;
  type?: string;
}

const THREAD_ITEM_TYPES = [
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'functionCallOutput',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
] as const;

@ApiExtraModels(...CODEX_V2_EXTRA_MODELS)
@Controller('codex-v2-contract')
class CodexV2ContractController {
  @Get()
  @ApiOkResponse({ type: TurnDto })
  read(): TurnDto {
    throw new Error('Schema-only test controller');
  }
}

describe('Codex v2 OpenAPI contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CodexV2ContractController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('contract').setVersion('test').build(),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Returns one generated component schema or fails with its missing name. */
  function schema(name: string): ContractSchema {
    const value = document.components?.schemas?.[name];
    expect(value, `missing OpenAPI schema ${name}`).toBeDefined();
    return value as ContractSchema;
  }

  /** Extracts a component name from a local OpenAPI reference. */
  function refName(value: ContractSchema): string {
    const ref = value.$ref ?? value.allOf?.[0]?.$ref;
    expect(ref).toMatch(/^#\/components\/schemas\//);
    return ref!.slice('#/components/schemas/'.length);
  }

  it('registers every pinned ThreadItem discriminator', () => {
    const itemUnion = schema('TurnDto').properties?.items?.items?.oneOf ?? [];
    const discriminators = itemUnion.map((arm) => {
      const itemSchema = schema(refName(arm));
      return itemSchema.properties?.type?.enum?.[0];
    });

    expect(discriminators).toEqual(THREAD_ITEM_TYPES);
  });

  it('exposes Codex 0.153 thread and asynchronous question metadata', () => {
    expect(Object.keys(schema('ThreadDto').properties ?? {})).toEqual(
      expect.arrayContaining(['model', 'reasoningEffort']),
    );
    expect(
      Object.keys(schema('AgentMessageThreadItemDto').properties ?? {}),
    ).toEqual(expect.arrayContaining(['questions']));
    expect(
      Object.keys(schema('AsyncUserInputQuestionDto').properties ?? {}),
    ).toEqual(expect.arrayContaining(['title', 'options']));
  });

  it.each([
    ['HookPromptThreadItemDto', ['type', 'id', 'fragments']],
    [
      'FunctionCallOutputThreadItemDto',
      ['type', 'id', 'name', 'namespace', 'output'],
    ],
    [
      'DynamicToolCallThreadItemDto',
      [
        'type',
        'id',
        'namespace',
        'tool',
        'arguments',
        'status',
        'contentItems',
        'success',
        'durationMs',
      ],
    ],
    [
      'CollabAgentToolCallThreadItemDto',
      [
        'type',
        'id',
        'tool',
        'status',
        'senderThreadId',
        'receiverThreadIds',
        'prompt',
        'model',
        'reasoningEffort',
        'agentsStates',
      ],
    ],
    [
      'SubAgentActivityThreadItemDto',
      ['type', 'id', 'kind', 'agentThreadId', 'agentPath'],
    ],
    ['WebSearchThreadItemDto', ['type', 'id', 'query', 'action', 'results']],
    ['ImageViewThreadItemDto', ['type', 'id', 'path']],
    ['SleepThreadItemDto', ['type', 'id', 'durationMs']],
    [
      'ImageGenerationThreadItemDto',
      [
        'type',
        'id',
        'status',
        'revisedPrompt',
        'result',
        'transparentBackground',
        'failure',
        'savedPath',
      ],
    ],
  ])('exposes the minimum renderer fields on %s', (name, fields) => {
    expect(Object.keys(schema(name).properties ?? {})).toEqual(
      expect.arrayContaining(fields),
    );
  });

  it('models standalone function output including every structured arm', () => {
    const output = schema('FunctionCallOutputThreadItemDto').properties?.output;
    const outputArms = output?.oneOf ?? [];
    const contentRefs = outputArms
      .find((arm) => arm.type === 'array')
      ?.items?.oneOf?.map(refName);

    expect(outputArms.some((arm) => arm.type === 'string')).toBe(true);
    expect(contentRefs).toEqual([
      'FunctionCallOutputInputTextDto',
      'FunctionCallOutputInputImageDto',
      'FunctionCallOutputInputAudioDto',
      'FunctionCallOutputEncryptedContentDto',
    ]);
  });

  it('models the renderer fields omitted by the previous mirror', () => {
    const dynamic = schema('DynamicToolCallThreadItemDto').properties;
    const dynamicContentRefs =
      dynamic?.contentItems?.items?.oneOf?.map(refName);
    const collabTools = schema('CollabAgentToolCallThreadItemDto').properties
      ?.tool?.enum;
    const webSearch = schema('WebSearchThreadItemDto').properties;
    const imageGeneration = schema('ImageGenerationThreadItemDto').properties;

    expect(dynamic).toHaveProperty('namespace');
    expect(dynamicContentRefs).toContain('DynamicToolCallOutputInputAudioDto');
    expect(collabTools).toEqual([
      'spawnAgent',
      'sendInput',
      'resumeAgent',
      'wait',
      'closeAgent',
      'sendMessage',
      'followupTask',
      'interruptAgent',
      'listAgents',
    ]);
    expect(webSearch).toHaveProperty('results');
    expect(imageGeneration?.transparentBackground?.nullable).toBe(true);
    expect(imageGeneration?.failure?.nullable).toBe(true);
  });

  it('keeps the misalignment category and public details inseparable', () => {
    expect(CODEX_ERROR_INFO_STRING_VALUES).toEqual([
      'contextWindowExceeded',
      'sessionBudgetExceeded',
      'usageLimitExceeded',
      'rateLimitExceeded',
      'serverOverloaded',
      'cyberPolicy',
      'misalignmentPolicyViolation',
      'internalServerError',
      'unauthorized',
      'badRequest',
      'threadRollbackFailed',
      'sandboxError',
      'other',
    ]);

    const turnError = schema('TurnErrorDto').properties;
    expect(turnError?.codexErrorInfo?.oneOf?.[0]?.enum).toEqual(
      CODEX_ERROR_INFO_STRING_VALUES,
    );
    expect(refName(turnError!.misalignment)).toBe('MisalignmentDetailsDto');
    const misalignment = schema('MisalignmentDetailsDto').properties;
    expect(Object.keys(misalignment ?? {})).toEqual([
      'errorType',
      'detailedExplanation',
    ]);
    expect(misalignment?.errorType?.nullable).toBe(true);
    expect(misalignment?.detailedExplanation?.nullable).toBe(true);
    expect(misalignment).not.toHaveProperty('steer');
  });
});
