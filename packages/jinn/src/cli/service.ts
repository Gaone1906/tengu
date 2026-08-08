import { getServiceStatus, installService, startService, stopService } from "../service/index.js";

function reportError(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

export async function runServiceInstall(): Promise<void> {
  try {
    const installedPath = installService();
    console.log(`Service definition installed at ${installedPath}.`);
    console.log('Run "jinn service start" to start it now — it also starts automatically on the next login/boot.');
  } catch (err) {
    reportError(err);
  }
}

export async function runServiceStart(): Promise<void> {
  try {
    await startService();
    console.log("Service started.");
  } catch (err) {
    reportError(err);
  }
}

export async function runServiceStop(): Promise<void> {
  try {
    await stopService();
    console.log("Service stopped.");
  } catch (err) {
    reportError(err);
  }
}

export async function runServiceStatus(): Promise<void> {
  try {
    const status = await getServiceStatus();
    if (!status.installed) {
      console.log('Service is not installed. Run "jinn service install" first.');
      return;
    }
    console.log(`Service: installed`);
    console.log(`Running: ${status.running ? "yes" : "no"}`);
  } catch (err) {
    reportError(err);
  }
}
