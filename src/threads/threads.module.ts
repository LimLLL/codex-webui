import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { CodexModule } from '../codex/codex.module';
import { ConversationBranchesModule } from '../conversation-branches/conversation-branches.module';
import { DatabaseModule } from '../database/database.module';
import { FilesModule } from '../files/files.module';
import { PendingApprovalsModule } from '../pending-approvals/pending-approvals.module';
import { ThreadDeletionModule } from '../thread-deletion/thread-deletion.module';
import { ActiveThreadRegistryService } from './active-thread-registry.service';
import { AutoResumeService } from './auto-resume.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadsBranchingService } from './threads-branching.service';
import { ThreadsController } from './threads.controller';
import { ThreadsDeletePlannerService } from './threads-delete-planner.service';
import { ThreadsDeletionController } from './threads-deletion.controller';
import { ThreadsDeletionService } from './threads-deletion.service';
import { ThreadsGateway } from './threads.gateway';
import { ThreadsService } from './threads.service';

@Module({
  imports: [
    AuthModule,
    ChatModule,
    CodexModule,
    ConversationBranchesModule,
    DatabaseModule,
    FilesModule,
    PendingApprovalsModule,
    ThreadDeletionModule,
  ],
  controllers: [ThreadsController, ThreadsDeletionController],
  providers: [
    ThreadsService,
    ThreadsBranchingService,
    ThreadsDeletePlannerService,
    ThreadsDeletionService,
    ThreadsGateway,
    ActiveThreadRegistryService,
    ThreadResumeRegistryService,
    AutoResumeService,
  ],
  exports: [
    ThreadsService,
    ThreadsBranchingService,
    ThreadsDeletePlannerService,
    ThreadsDeletionService,
    ActiveThreadRegistryService,
    ThreadResumeRegistryService,
  ],
})
export class ThreadsModule {}
