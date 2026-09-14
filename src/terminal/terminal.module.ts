import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { SettingsModule } from '../settings/settings.module';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';
import { TerminalRegistryService } from './terminal-registry.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FilesModule, SettingsModule, DatabaseModule, AuthModule],
  providers: [TerminalService, TerminalGateway, TerminalRegistryService],
  exports: [TerminalService],
})
export class TerminalModule {}
