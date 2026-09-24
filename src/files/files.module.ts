import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { FilesController } from './files.controller';
import { FilesGateway } from './files.gateway';
import { FilesService } from './files.service';
import { FileWatchCoordinatorService } from './file-watch-coordinator.service';

@Module({
  imports: [SettingsModule, CodexModule, AuthModule],
  controllers: [FilesController],
  providers: [FilesService, FileWatchCoordinatorService, FilesGateway],
  exports: [FilesService],
})
export class FilesModule {}
