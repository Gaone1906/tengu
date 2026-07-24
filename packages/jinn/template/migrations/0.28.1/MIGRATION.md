# Instance migration bundle: 0.28.0 → 0.28.1

<!-- BEGIN RELEASE RATIONALE -->
Jinn 0.28.1 changed no user-owned instance-template files. This empty bundle records the patch release in the strict migration chain.
<!-- END RELEASE RATIONALE -->

This file is generated. The manifest is authoritative; each record below appears exactly once.
The payload paths below are generic package sources. Before review, the gateway creates audited, read-only materialized base payload and materialized target payload copies beneath the instance migration snapshot using that instance's exact template replacements.
Perform the three-way merge only from those materialized snapshot payloads and the current user-owned instance file. Never apply a raw generic payload or copy an unresolved placeholder into the instance. Preserve user customizations and never delete user content without explicit review and a snapshot.
