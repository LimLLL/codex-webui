import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';

@Module({
  imports: [CodexModule],
  controllers: [AppsController],
  providers: [AppsService],
  exports: [AppsService],
})
export class AppsModule {}
