/**
 * Global test setup: DOM matchers, and unmounting rendered trees between tests
 * so DOM state never leaks.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);
