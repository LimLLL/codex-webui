/** Turn diff persistence module. */
import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { ConversationBranchesModule } from '../conversation-branches/conversation-branches.module';
import { DatabaseModule } from '../database/database.module';
import { TurnDiffController } from './turn-diff.controller';
import { TurnDiffService } from './turn-diff.service';

@Module({
  imports: [CodexModule, ConversationBranchesModule, DatabaseModule],
  controllers: [TurnDiffController],
  providers: [TurnDiffService],
  exports: [TurnDiffService],
})
export class TurnDiffModule {}
