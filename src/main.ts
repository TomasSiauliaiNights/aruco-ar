/**
 * App shell: start screen -> AR view, plus the error dialog and the one-time
 * service-worker registration.
 *
 * ARController and everything it pulls in (three.js, the worker, the detector)
 * are dynamically imported from the Start handler, so the initial bundle is just
 * this file and the stylesheet. That is what keeps first paint instant and the
 * initial JS inside budget; the heavy machinery arrives while the camera
 * permission prompt is on screen.
 */

// app.css is linked from index.html rather than imported here, so the start
// screen is styled on first paint instead of flashing unstyled while JS loads.

type Controller = import('./ARController').ARController;

const el = {
  start: must<HTMLElement>('start'),
  startBtn: must<HTMLButtonElement>('start-btn'),
  startStatus: must<HTMLElement>('start-status'),
  ar: must<HTMLElement>('ar'),
  video: must<HTMLVideoElement>('video'),
  gl: must<HTMLCanvasElement>('gl'),
  overlay: must<HTMLCanvasElement>('overlay'),
  debug: must<HTMLElement>('debug'),
  lockPill: must<HTMLElement>('lock-pill'),
  loading: must<HTMLElement>('loading'),
  loadingFill: must<HTMLElement>('loading-fill'),
  loadingText: must<HTMLElement>('loading-text'),
  btnBack: must<HTMLButtonElement>('btn-back'),
  btnDebug: must<HTMLButtonElement>('btn-debug'),
  btnTorch: must<HTMLButtonElement>('btn-torch'),
  btnSwap: must<HTMLButtonElement>('btn-swap'),
  btnShot: must<HTMLButtonElement>('btn-shot'),
  error: must<HTMLElement>('error'),
  errorTitle: must<HTMLElement>('error-title'),
  errorBody: must<HTMLElement>('error-body'),
  errorClose: must<HTMLButtonElement>('error-close'),
};

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} in the document`);
  return node as T;
}

let controller: Controller | null = null;
let starting = false;
let statusTimer = 0;

function setStatus(message: string): void {
  el.startStatus.textContent = message;
  window.clearTimeout(statusTimer);
  if (message) {
    statusTimer = window.setTimeout(() => {
      el.startStatus.textContent = '';
    }, 5000);
  }
}

function showError(title: string, body: string): void {
  el.errorTitle.textContent = title;
  el.errorBody.textContent = body;
  el.error.hidden = false;
}

function showStartScreen(): void {
  el.ar.hidden = true;
  el.start.hidden = false;
  el.error.hidden = true;
  el.btnDebug.setAttribute('aria-pressed', 'false');
  controller?.stop();
  controller = null;
}

async function startAr(): Promise<void> {
  if (starting || controller) return;
  starting = true;
  el.startBtn.disabled = true;
  setStatus('Requesting camera…');

  try {
    const { ARController } = await import('./ARController');
    el.start.hidden = true;
    el.ar.hidden = false;

    const instance = new ARController(
      {
        root: el.ar,
        video: el.video,
        gl: el.gl,
        overlay: el.overlay,
        debug: el.debug,
        lockPill: el.lockPill,
        loading: el.loading,
        loadingFill: el.loadingFill,
        loadingText: el.loadingText,
        torchButton: el.btnTorch,
        swapButton: el.btnSwap,
        shotButton: el.btnShot,
        debugButton: el.btnDebug,
      },
      {
        onFatalError: (title, body) => {
          showError(title, body);
        },
        onStatus: (message) => {
          el.lockPill.textContent = message;
        },
      },
    );

    await instance.start();
    controller = instance;
    setStatus('');
  } catch (err) {
    // The controller surfaces camera problems through onFatalError; anything
    // reaching here is a load failure, which deserves its own message.
    if (el.error.hidden) {
      showError(
        'Could not start',
        `${String((err as Error)?.message ?? err)}. Reloading the page usually clears this.`,
      );
    }
    el.start.hidden = false;
    el.ar.hidden = true;
  } finally {
    starting = false;
    el.startBtn.disabled = false;
  }
}

el.startBtn.addEventListener('click', () => void startAr());
el.btnBack.addEventListener('click', () => showStartScreen());
el.errorClose.addEventListener('click', () => showStartScreen());
el.btnDebug.addEventListener('click', () => controller?.toggleDebug());
el.btnTorch.addEventListener('click', () => void controller?.toggleTorch());
el.btnSwap.addEventListener('click', () => void controller?.switchCamera());
el.btnShot.addEventListener('click', () => controller?.requestScreenshot());

// Spacebar for the debug panel is handy while holding a phone in one hand and
// a marker in the other; 'd' is the mnemonic.
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'd' && controller) controller.toggleDebug();
});

// Offline support. Registered after load so it never competes with the first
// paint or the camera start for bandwidth.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js', document.baseURI).href;
    navigator.serviceWorker.register(swUrl, { scope: new URL('./', document.baseURI).pathname }).catch(() => {
      // Offline support is optional; the app works without it.
    });
  });
}

// A warning worth giving before the user taps Start and gets a confusing failure.
if (!window.isSecureContext) {
  setStatus('This page is not on HTTPS, so the camera will not start.');
}
