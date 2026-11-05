import { writeY4m } from './y4m';
import { FAKE_VIDEO } from '../../playwright.config';

/**
 * Generates the fake-camera clip before the browser launches, because Chromium
 * reads the file at startup from its command line.
 */
export default function globalSetup(): void {
  writeY4m(FAKE_VIDEO, { width: 640, height: 480, fps: 30, frames: 90, markerId: 0 });
  // eslint-disable-next-line no-console
  console.log(`fake camera clip: ${FAKE_VIDEO}`);
}
