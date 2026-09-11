/** Content-free hints must eventually cause a read newer than the hint. */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { invalidateThreadListSoon } from './query-invalidation';

afterEach(() => vi.useRealTimers());

it('does not lose a hint by joining an initial fetch served before it', async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  let finish!: (value: string) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          finish = done;
        }),
    )
    .mockResolvedValue('fresh');
  const observer = new QueryObserver(client, {
    queryKey: [{ _id: 'threadsListOverview' }],
    queryFn: fetch,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  invalidateThreadListSoon(client);
  await vi.advanceTimersByTimeAsync(300);
  expect(fetch).toHaveBeenCalledTimes(1);
  finish('stale');
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(observer.getCurrentResult().data).toBe('fresh');
  unsubscribe();
  client.clear();
});

it('bounds refresh delay even when hints arrive continuously', async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  for (let i = 0; i < 3; i++) {
    invalidateThreadListSoon(client);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(invalidate).toHaveBeenCalled();
  client.clear();
});
