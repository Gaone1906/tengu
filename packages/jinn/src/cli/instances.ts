// Compatibility facade for CLI modules. Host-level workspace behavior lives in
// instances/directory so the gateway never imports a command-layer module.
export {
  ensureDefaultInstance,
  findInstance,
  loadInstances,
  nextAvailablePort,
  saveInstances,
  type Instance,
  type InstanceInput,
} from "../instances/directory.js";
