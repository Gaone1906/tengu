import fs from 'node:fs';
import {
  assertIsolatedTestHome,
  ensureIsolatedTestHome,
} from './vitest.test-home.js';

export default function setup(): (() => void) | undefined {
  const result = ensureIsolatedTestHome();

  // Belt-and-suspenders: never continue if assignment/canonicalization did not
  // actually move the run away from the production or another non-temp home.
  assertIsolatedTestHome(process.env.JINN_HOME);

  if (!result.created) return undefined;
  return () => {
    fs.rmSync(result.home, { recursive: true, force: true });
  };
}
