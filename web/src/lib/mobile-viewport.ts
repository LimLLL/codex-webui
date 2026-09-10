/**
 * Mirrors the visual viewport into `--app-vh`, the height every full-height
 * surface in the app is sized from.
 *
 * `100dvh` tracks retractable browser chrome but not the software keyboard on
 * iOS, where the keyboard neither resizes the layout viewport nor honours
 * `interactive-widget`. Some embedded browsers additionally draw a bottom
 * toolbar over the page without reducing `innerHeight`. In both cases a
 * `100dvh` shell puts the composer underneath something, and
 * `visualViewport.height` is the only reading that reflects what is visible.
 */

/** Extra bottom padding reserved for overlay browser chrome (QQ Browser). */
const QQ_BOTTOM_GAP_PX = 56;

/** Matches QQ Browser and its embedded webview user agents. */
const QQ_BROWSER_UA = /MQQBrowser|QQBrowser|QQ\//i;

/**
 * WeChat's Android webview is built on the same X5/TBS engine and carries
 * `MQQBrowser` in its user agent, but draws no such toolbar. Without this
 * exclusion every WeChat user loses a strip of the composer area to chrome
 * that is not there.
 */
const WECHAT_UA = /MicroMessenger/i;

/** Marks QQ Browser so CSS can reserve space for its overlay toolbar. */
function markQqBrowser(): void {
  const ua = navigator.userAgent;
  if (WECHAT_UA.test(ua) || !QQ_BROWSER_UA.test(ua)) return;
  document.documentElement.classList.add('qq-browser');
  document.documentElement.style.setProperty(
    '--qq-bottom-gap',
    `${QQ_BOTTOM_GAP_PX}px`,
  );
}

/**
 * Installs the viewport sync and returns a cleanup function.
 *
 * Each call registers its own listeners and its own cleanup, so calling it
 * more than once leaks nothing as long as every returned function is invoked.
 *
 * @returns Removes the listeners this call registered.
 */
export function installMobileViewportFixes(): () => void {
  markQqBrowser();

  const root = document.documentElement;
  let applied: string | null = null;

  const sync = () => {
    const viewport = window.visualViewport;
    // Pinch zoom shrinks the visual viewport without shrinking the layout, and
    // scrolls it away from the document origin. Sizing the shell from it then
    // collapses the whole app to the magnified region — and because the visual
    // viewport also emits `scroll` while zoomed, it would do so on every pan.
    // The layout is already correct at scale 1, so zoom simply holds the last
    // reading. `offsetTop` needs no separate handling for the same reason: it
    // is only non-zero while zoomed or mid-keyboard-transition, and the shell
    // shrinking to the viewport height is what lets the browser settle it back.
    if (viewport && viewport.scale !== 1) return;
    const height = viewport?.height || window.innerHeight || 0;
    if (height <= 0) return;
    const next = `${height}px`;
    // `scroll` fires far more often than the height changes; writing an
    // identical value still dirties style on every one of them.
    if (next === applied) return;
    applied = next;
    root.style.setProperty('--app-vh', next);
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
