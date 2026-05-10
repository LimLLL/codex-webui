import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  /** Returns service health status. */
  getStatus(): { status: string } {
    return { status: 'ok' };
  }
}
