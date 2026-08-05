---
name: experiments
description: Create, measure, update, and conclude tracked experiments
---

# Experiments Skill

Use an Experiment when a decision depends on a testable hypothesis, measurable baseline, explicit metrics, and a time horizon. Keep ordinary tasks in Todos and reusable procedure in Workflows.

## Tools

- `list_experiments`: inspect running or concluded experiments.
- `get_experiment`: read one experiment with its metrics and readings.
- `create_experiment`: define the name, hypothesis, baseline, metrics, horizon, and optional check-in schedule.
- `update_experiment`: edit the definition of a running experiment.
- `record_reading`: append a dated metric value and optional note.
- `conclude_experiment`: finish with a win, loss, or inconclusive verdict and supporting note.

## Operating rule

State the decision the experiment will inform before creating it. Use metrics that can actually be observed, preserve the baseline, and record readings without rewriting history. Change a running definition only when the measurement plan genuinely changes, and explain the change in the next reading.

Conclude at the declared horizon or when a valid stopping condition is met. Base the verdict on recorded evidence, state limitations plainly, and turn follow-up work into a Todo or Workflow only when there is a real owned outcome or reusable procedure.
