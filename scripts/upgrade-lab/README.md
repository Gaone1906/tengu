# Jinn upgrade lab

This harness tests one exact candidate package against a real `jinn-cli@0.25.0`
install in a nonce-owned disposable home. It refuses the live instance tree,
derives and reserves a deterministic high loopback port from the lab nonce,
rejects protected ports `7777` and `7801`, persists the selected port into the
disposable `config.yaml`, verifies process ownership before every signal,
builds a minimal child environment, and never copies or mounts an instance
secret store.

```bash
pnpm upgrade-lab -- --scenario customized --candidate-tarball /tmp/jinn-cli-0.26.0.tgz
```

Scenarios are `stock`, `customized`, `heavily-customized`, `interrupted`, and
`no-instance-change`. Use `--keep` to retain the printed artifact directory.
Use `--dry-run` to validate all guards without installing or spawning anything.

The local-process runner is canonical and works without Docker. The optional
container runs that same file; prepare both package tarballs outside the
container, mount only the repository read-only and a new disposable output
directory, and run the container with `--network none`. Never mount a host home.

```bash
docker build -t jinn-upgrade-lab scripts/upgrade-lab
docker run --rm --network none \
  --mount type=bind,src="$PWD",dst=/workspace,readonly \
  jinn-upgrade-lab --scenario stock --candidate-tarball /artifacts/jinn-cli-0.26.0.tgz
```

Explicit `--docker` fails clearly when Docker is unavailable; omit the flag to
use the guarded local runner. Results, prompt bytes, manifest audit, and the exact
candidate SHA-256 are recorded under the lab's `artifacts/` directory.
