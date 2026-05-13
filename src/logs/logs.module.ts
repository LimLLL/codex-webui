/** Logs module exposing structured log browsing and diagnostics export. */
import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';

@Module({
  imports: [CodexModule],
  controllers: [LogsController],
  providers: [LogsService],
})
export class LogsModule {}
