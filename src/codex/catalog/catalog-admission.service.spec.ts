/** Admission tests exercise asynchronous gaps and release on completion, failure and cancellation. */
import type { ExecutionContext } from '@nestjs/common';
import { Subject, of, throwError } from 'rxjs';
import {
  CatalogAdmissionService,
  CatalogMutationInterceptor,
} from './catalog-admission.service';

function httpContext(method: string, url: string): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
  } as unknown as ExecutionContext;
}

describe('catalog admission', () => {
  it('refuses application throughout a multi-step mutation and refuses a second application', () => {
    const admission = new CatalogAdmissionService();
    const release = admission.enter('fork');
    expect(() => admission.begin()).toThrow('Mutations');
    release();
    const finish = admission.begin();
    expect(() => admission.enter('turn/start')).toThrow();
    expect(() => admission.assertOpen()).toThrow();
    expect(() => admission.begin()).toThrow();
    finish();
    expect(admission.pending()).toEqual([]);
    expect(() => admission.assertOpen()).not.toThrow();
  });
  it('holds an HTTP operation until it settles, including gaps between RPC calls', () => {
    const admission = new CatalogAdmissionService();
    const interceptor = new CatalogMutationInterceptor(admission);
    const response = new Subject<unknown>();
    const subscription = interceptor
      .intercept(httpContext('POST', '/api/threads/t/fork'), {
        handle: () => response,
      })
      .subscribe();
    expect(() => admission.begin()).toThrow();
    response.next({ intermediate: true });
    expect(() => admission.begin()).toThrow();
    subscription.unsubscribe();
    const finish = admission.begin();
    finish();
  });
  it('releases failed mutations and leaves read-only/repair controls accessible', () => {
    const admission = new CatalogAdmissionService();
    const interceptor = new CatalogMutationInterceptor(admission);
    interceptor
      .intercept(httpContext('PUT', '/api/codex/config/raw'), {
        handle: () => throwError(() => new Error('failed')),
      })
      .subscribe({ error: () => undefined });
    const finish = admission.begin();
    expect(() =>
      interceptor.intercept(httpContext('GET', '/api/codex/catalog'), {
        handle: () => of({}),
      }),
    ).not.toThrow();
    expect(() =>
      interceptor.intercept(httpContext('POST', '/api/codex/catalog/apply'), {
        handle: () => of({}),
      }),
    ).not.toThrow();
    expect(() =>
      interceptor.intercept(httpContext('POST', '/api/threads/t/turns'), {
        handle: () => of({}),
      }),
    ).toThrow();
    finish();
  });
});
