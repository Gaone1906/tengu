# Cron

Cron jobs are simple scheduled prompts stored in `$JINN_HOME/cron/jobs.json`. The gateway validates and hot-reloads the array. Use `skills/cron-manager/SKILL.md` for creation, mutation, validation, delivery, and run-history procedure.

## Job contract

```typescript
interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine: string;
  model?: string;
  employee?: string;
  prompt: string;
  delivery?: { connector: string; channel: string };
}
```

`delivery.connector` is a connector instance id, for example `slack` or `slack-support`.

`schedule` uses standard five-field cron syntax. `timezone` is an IANA timezone; when omitted, the system timezone applies. Engine values are claude, codex, antigravity, grok, pi, hermes. A model override must be supported by its engine.

## Delivery ownership

Analytical, reporting, or decision-informing output should target the COO. The COO delegates specialist work, reviews it, and produces the final deliverable. Direct employee delivery is reserved for simple output that does not need review.

## Workflows versus cron

Use cron for one scheduled prompt. Use a Workflow when the procedure needs multiple phases, conditions, approvals, reusable evidence, or non-schedule triggers. A schedule Trigger belongs to the Workflow definition; do not create a second cron job for the same wake-up.

Use the cron read tools for current definitions and run evidence. Local run logs are implementation detail, not the normal operating surface.
