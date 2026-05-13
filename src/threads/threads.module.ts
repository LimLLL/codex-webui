import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CodexModule } from '../codex/codex.module';
import { ActiveThreadRegistryService } from './active-thread-registry.service';
import { AutoResumeService } from './auto-resume.service';
import { ThreadsController } from './threads.controller';
import { ThreadsGateway } from './threads.gateway';
import { ThreadsService } from './threads.service';

@Module({
  imports: [AuthModule, CodexModule],
  controllers: [ThreadsController],
  providers: [
    ThreadsService,
    ThreadsGateway,
    ActiveThreadRegistryService,
    AutoResumeService,
  ],
  exports: [ThreadsService, ActiveThreadRegistryService],
})
export class ThreadsModule {}
