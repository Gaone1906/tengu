# Prerelease Todo converter

This root-only tool inventories the operator's unsupported prerelease `wi_*` Todo data before a separately authorized offline conversion. It is not part of `jinn-cli`, has no installed command, has no instance default paths, and must never be imported from `packages/`.

Current boundary: **dry run only**. There is deliberately no apply or rewrite entry point.

The dry run requires four explicit inputs:

```text
dry-run.mjs \
  --database <offline-source.db> \
  --backup <external-byte-exact-backup.db> \
  --restore-rehearsal <new-disposable-db-path> \
  --artifacts <manifest.json>
```

The manifest has no default roots:

```json
{
  "roots": [
    {
      "kind": "workflow",
      "sourcePath": "/explicit/offline/workflow-root",
      "backupPath": "/explicit/external/workflow-backup",
      "restorePath": "/explicit/new/rehearsal-root",
      "files": ["workflow-id/runs/run-id.json"]
    },
    {
      "kind": "poll",
      "sourcePath": "/explicit/offline/poll-root",
      "backupPath": "/explicit/external/poll-backup",
      "restorePath": "/explicit/new/rehearsal-root",
      "files": ["trigger-id.json"]
    }
  ]
}
```

Every listed root is a closed allowlist. The reviewed native helper opens roots and leaves descriptor-relative with no symlink following, bounds file count/depth/size, and refuses unexpected entries. Reports contain only counts, safe locators, and SHA-256 evidence—not the legacy IDs, mapping, or filesystem paths.

Never point this tool at the live `~/.jinn` database. Live conversion, gateway restart, first start, deployment, release, and publication each require separate explicit authorization.
