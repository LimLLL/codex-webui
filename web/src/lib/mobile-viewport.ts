/**
 * Mobile viewport fixes.
 *
 * QQ Browser (and similar embedded browsers) draw a bottom toolbar that
 * overlays the page without changing `window.innerHeight`, so a 100dvh shell
 * still hides the composer underneath it. Mirroring `visualViewport.height`
 * into `--app-vh` lets CSS track what is actually visible.
 */

/** Extra bottom padding reserved for overlay browser chrome (QQ Browser). */
const QQ_BOTTOM_GAP_PX = 56;

/** Matches QQ Browser and its embedded webview user agents. */
const QQ_BROWSER_UA = /MQQBrowser|QQBrowser|QQ\//i;

/** Keeps the viewport meta honest about keyboard/viewport resizing behaviour. */
function ensureInteractiveWidget(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.getAttribute('content') ?? '';
  if (!content || content.includes('interactive-widget')) return;
  meta.setAttribute('content', `${content}, interactive-widget=resizes-content`);
}

/** Marks QQ Browser so CSS can reserve space for its overlay toolbar. */
function markQqBrowser(): void {
  if (!QQ_BROWSER_UA.test(navigator.userAgent)) return;
  document.documentElement.classList.add('qq-browser');
  document.documentElement.style.setProperty(
    '--qq-bottom-gap',
    `${QQ_BOTTOM_GAP_PX}px`,
  );
}

/**
 * Installs the viewport fixes and returns a cleanup function.
 *
 * Safe to call more than once; every listener is registered against the same
 * sync function and removed on cleanup.
 */
export function installMobileViewportFixes(): () => void {
  ensureInteractiveWidget();
  markQqBrowser();

  const sync = () => {
    const height = window.visualViewport?.height || window.innerHeight || 0;
    if (height > 0) {
      document.documentElement.style.setProperty('--app-vh', `${height}px`);
    }
  };

  sync();
  window.addEventListener('resize', sync, { passive: true });
  window.addEventListener('orientationchange', sync, { passive: true });
  window.visualViewport?.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('scroll', sync, { passive: true });

  return () => {
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
  };
}
