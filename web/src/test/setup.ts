/** Global test setup: unmount rendered trees between tests so DOM state never leaks. */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
