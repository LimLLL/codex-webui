import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Basic health check endpoint. */
  @Get('status')
  @ApiOperation({ summary: 'Health check' })
  getStatus(): { status: string } {
    return this.appService.getStatus();
  }
}
