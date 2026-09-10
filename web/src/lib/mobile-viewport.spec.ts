/** Covers the viewport sync's zoom guard, write elision, and UA classification. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMobileViewportFixes } from './mobile-viewport';

interface FakeViewport {
  height: number;
  scale: number;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
}

/** Stands in for `window.visualViewport`, which jsdom does not implement. */
function fakeVisualViewport(height: number, scale = 1): FakeViewport {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    scale,
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    emit: (type) => listeners.get(type)?.forEach((listener) => listener()),
  };
}

/** Installs a stub visual viewport and returns it. */
function useViewport(height: number, scale = 1): FakeViewport {
  const viewport = fakeVisualViewport(height, scale);
  Object.defineProperty(window, 'visualViewport', {
    value: viewport,
    configurable: true,
    writable: true,
  });
  return viewport;
}

/** Overrides the user agent for one test. */
function useUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true,
  });
}

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const QQ_BROWSER =
  'Mozilla/5.0 (Linux; U; Android 12; zh-cn; Build/SP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 MQQBrowser/13.7 Mobile Safari/537.36';
const WECHAT_X5 =
  'Mozilla/5.0 (Linux; Android 8.0; MI 6 Build/OPR1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/6.2 TBS/044207 Mobile Safari/537.36 MicroMessenger/6.7.2.1340(0x2607023A) NetType/WIFI Language/zh_CN';

describe('installMobileViewportFixes', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    document.documentElement.classList.remove('qq-browser');
    document.documentElement.removeAttribute('style');
    useUserAgent(CHROME_ANDROID);
    vi.restoreAllMocks();
  });

  /** Installs the fixes and registers the cleanup for teardown. */
  function install(): void {
    cleanups.push(installMobileViewportFixes());
  }

  it('publishes the visible height and tracks it as the viewport changes', () => {
    const viewport = useViewport(800);
    install();
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );

    // The iOS keyboard shrinks the visual viewport without resizing the layout.
    viewport.height = 500;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '500px',
    );
  });

  it('holds the last height while the page is pinch-zoomed', () => {
    const viewport = useViewport(800);
    install();

    // Zooming to 2x halves the visual viewport. Sizing the shell from it would
    // collapse the whole app to the magnified region.
    viewport.height = 400;
    viewport.scale = 2;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );

    // Zooming back out resumes tracking.
    viewport.height = 780;
    viewport.scale = 1;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '780px',
    );
  });

  it('does not rewrite the property when the height is unchanged', () => {
    const viewport = useViewport(800);
    install();
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');

    // Panning fires `scroll` continuously; the height is the same every time.
    viewport.emit('scroll');
    viewport.emit('scroll');
    expect(setProperty).not.toHaveBeenCalled();
  });

  it('stops tracking once cleaned up', () => {
    const viewport = useViewport(800);
    install();
    cleanups.splice(0).forEach((cleanup) => cleanup());

    viewport.height = 500;
    viewport.emit('resize');
    expect(document.documentElement.style.getPropertyValue('--app-vh')).toBe(
      '800px',
    );
  });

  it('reserves toolbar space for QQ Browser but not for WeChat', () => {
    useViewport(800);
    useUserAgent(QQ_BROWSER);
    install();
    expect(document.documentElement.classList.contains('qq-browser')).toBe(true);

    document.documentElement.classList.remove('qq-browser');
    // WeChat's older Android webview shares the X5 engine and reports
    // `MQQBrowser`, but draws no bottom toolbar.
    useUserAgent(WECHAT_X5);
    install();
    expect(document.documentElement.classList.contains('qq-browser')).toBe(false);
  });
});
