/** Marks a route as publicly accessible without WebUI authentication. */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Allows controllers or handlers to bypass the global API/JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
