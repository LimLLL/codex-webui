import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

@Module({
  imports: [CodexModule],
  controllers: [PluginsController],
  providers: [PluginsService],
  exports: [PluginsService],
})
export class PluginsModule {}
