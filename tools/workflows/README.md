# Authored workflows

These JSON files are the reviewable authored source for Jinn's operational workflows. The
gateway database remains authoritative at runtime: editing a file here does not change a
running workflow, and runtime enablement is managed separately.

To apply an existing workflow, read its current revision with `get_workflow`, then pass the
complete JSON object to `update_workflow` with that revision as `expectedRevision`. To apply
a new workflow, call `create_workflow` with the file's `id`, `title`, and `description`, then
pass the complete JSON object to `update_workflow` using the revision returned by creation.
Do not enable a newly created workflow until its saved definition has been reviewed.

The gateway preserves its own identity, revision, enablement, and timestamps when updating
an existing workflow. After applying a file, read the canonical definition back with
`get_workflow` and compare its graph (`nodes`, `edges`, and `ui`) with the authored source.
