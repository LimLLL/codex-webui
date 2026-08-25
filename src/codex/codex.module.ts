import { Module } from '@nestjs/common';
import { CodexConfigController } from './codex-config.controller';
import { CodexFeedbackController } from './codex-feedback.controller';
import { CodexProcessManager } from './codex-process-manager.service';
import { CodexStatusController } from './codex-status.controller';
import { CodexStatusService } from './codex-status.service';
import { CodexService } from './codex.service';

@Module({
  controllers: [
    CodexStatusController,
    CodexConfigController,
    CodexFeedbackController,
  ],
  providers: [CodexProcessManager, CodexService, CodexStatusService],
  exports: [CodexProcessManager, CodexService, CodexStatusService],
})
export class CodexModule {}
