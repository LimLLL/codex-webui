import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { CodexModule } from '../codex/codex.module';
import { ConversationBranchesModule } from '../conversation-branches/conversation-branches.module';
import { FilesModule } from '../files/files.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { ActiveThreadRegistryService } from './active-thread-registry.service';
import { AutoResumeService } from './auto-resume.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadsBranchingService } from './threads-branching.service';
import { ThreadsController } from './threads.controller';
import { ThreadsGateway } from './threads.gateway';
import { ThreadsService } from './threads.service';

@Module({
  imports: [
    AuthModule,
    ChatModule,
    CodexModule,
    ConversationBranchesModule,
    FilesModule,
    PendingApprovalsModule,
  ],
  controllers: [ThreadsController],
  providers: [
    ThreadsService,
    ThreadsBranchingService,
    ThreadsGateway,
    ActiveThreadRegistryService,
    ThreadResumeRegistryService,
    AutoResumeService,
  ],
  exports: [
    ThreadsService,
    ThreadsBranchingService,
    ActiveThreadRegistryService,
    ThreadResumeRegistryService,
  ],
})
export class ThreadsModule {}
