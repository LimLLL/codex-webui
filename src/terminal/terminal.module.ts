import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { SettingsModule } from '../settings/settings.module';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';

@Module({
  imports: [FilesModule, SettingsModule],
  providers: [TerminalService, TerminalGateway],
  exports: [TerminalService],
})
export class TerminalModule {}
