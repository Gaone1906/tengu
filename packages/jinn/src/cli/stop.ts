import { stop } from "../gateway/lifecycle.js";

export async function runStop(port?: number, opts: { takePort?: boolean } = {}): Promise<void> {
  let stopped: boolean;
  try {
    stopped = stop(port, { takePort: opts.takePort });
  } catch (err) {
    if (err instanceof Error && (err.name === "PortOwnershipError" || err.name === "UnsafeContainerTakeoverError")) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (stopped) {
    console.log("Gateway stopped.");
  } else {
    console.log("Gateway is not running.");
  }
}
