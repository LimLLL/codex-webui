import { Module } from '@nestjs/common';
import { TerminalGateway } from './terminal.gateway';
import { TerminalService } from './terminal.service';

@Module({
  providers: [TerminalService, TerminalGateway],
  exports: [TerminalService],
})
export class TerminalModule {}
