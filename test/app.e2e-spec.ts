import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

const TEST_API_KEY = process.env.WEBUI_API_KEY ?? 'test-api-key';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.WEBUI_API_KEY = TEST_API_KEY;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('/api/status (GET) with valid auth', () => {
    return request(app.getHttpServer())
      .get('/api/status')
      .set('Authorization', `Bearer ${TEST_API_KEY}`)
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('/api/status (GET) without auth should 401', () => {
    return request(app.getHttpServer()).get('/api/status').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
