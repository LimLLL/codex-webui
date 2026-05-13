/** Token usage persistence module. */
import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { DatabaseModule } from '../database/database.module';
import { TokenUsageController } from './token-usage.controller';
import { TokenUsageService } from './token-usage.service';

@Module({
  imports: [CodexModule, DatabaseModule],
  controllers: [TokenUsageController],
  providers: [TokenUsageService],
  exports: [TokenUsageService],
})
export class TokenUsageModule {}
