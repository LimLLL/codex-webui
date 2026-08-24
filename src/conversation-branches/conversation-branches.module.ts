import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConversationBranchesService } from './conversation-branches.service';

@Module({
  imports: [DatabaseModule],
  providers: [ConversationBranchesService],
  exports: [ConversationBranchesService],
})
export class ConversationBranchesModule {}
