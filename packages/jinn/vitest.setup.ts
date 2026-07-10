import { assertIsolatedTestHome } from './vitest.test-home.js';

// setupFiles execute inside each worker before its test module is evaluated.
// Abort loudly if the pre-worker global setup ever stops propagating its home.
assertIsolatedTestHome(process.env.JINN_HOME);
