/** Turn error persistence module. */
import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { ConversationBranchesModule } from '../conversation-branches/conversation-branches.module';
import { DatabaseModule } from '../database/database.module';
import { TurnErrorsController } from './turn-errors.controller';
import { TurnErrorsService } from './turn-errors.service';

@Module({
  imports: [CodexModule, ConversationBranchesModule, DatabaseModule],
  controllers: [TurnErrorsController],
  providers: [TurnErrorsService],
  exports: [TurnErrorsService],
})
export class TurnErrorsModule {}
