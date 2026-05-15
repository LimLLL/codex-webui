import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { FilesController } from './files.controller';
import { FilesGateway } from './files.gateway';
import { FilesService } from './files.service';

@Module({
  imports: [SettingsModule],
  controllers: [FilesController],
  providers: [FilesService, FilesGateway],
  exports: [FilesService],
})
export class FilesModule {}
