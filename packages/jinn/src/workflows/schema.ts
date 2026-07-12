import { z } from 'zod';
import { CONDITION_OPS } from './condition.js';

// Runtime constants live beside the shared schemas so definition.ts can consume
// strict parsing without a schema.ts -> definition.ts -> schema.ts initialization cycle.
export const STEP_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const STEP_RETRY_CAUSES = ['error', 'no-output', 'interrupted', 'timeout'] as const;
export const STEP_OUTPUT_MODES = ['handoff', 'full', 'none'] as const;
export const STEP_ON_ERROR_MODES = ['fail-run', 'continue', 'error-edge'] as const;
export const STEP_SESSION_MODES = ['fresh', 'workflow', 'existing'] as const;
export const WORK_ITEM_STATUSES = ['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'escalated', 'cancelled'] as const;
export const NODE_TYPES = ['trigger', 'step', 'gate', 'switch', 'fail', 'wait'] as const;
export const SWITCH_MODES = ['firstMatch', 'allMatches'] as const;
export const ACTOR_KINDS = ['employee', 'engine'] as const;
export const EDGE_KINDS = ['handoff', 'sequence', 'loop'] as const;

export const WORKFLOW_AUTHORITY_FIELDS = [
  'owner',
  'ownerEmployee',
  'workflowOwner',
  'createdBy',
  'creator',
  'author',
  'department',
  'ownerDepartment',
  'workflowDepartment',
  'critical',
  'cooOwned',
  'requiresCooApproval',
  'classification',
  'authority',
] as const;

const finiteNumber = z.number().finite();

const workflowAuthorityShape = {
  owner: z.string().optional(),
  ownerEmployee: z.string().optional(),
  workflowOwner: z.string().optional(),
  createdBy: z.string().optional(),
  creator: z.string().optional(),
  author: z.string().optional(),
  department: z.string().optional(),
  ownerDepartment: z.string().optional(),
  workflowDepartment: z.string().optional(),
  critical: z.boolean().optional(),
  cooOwned: z.boolean().optional(),
  requiresCooApproval: z.boolean().optional(),
  classification: z.string().optional(),
  authority: z.string().optional(),
} as const;

export const workflowPositionSchema = z.strictObject({
  x: finiteNumber,
  y: finiteNumber,
});

export const workflowActorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  ref: z.string(),
});

export const workflowRetryPolicySchema = z.strictObject({
  maxAttempts: z.number().int(),
  on: z.array(z.enum(STEP_RETRY_CAUSES)),
});

export const workflowSessionSpecSchema = z.strictObject({
  mode: z.enum(STEP_SESSION_MODES),
  sessionId: z.string().optional(),
});

export const workflowStepOptionsSchema = z.strictObject({
  model: z.string().optional(),
  effort: z.enum(STEP_EFFORT_LEVELS).optional(),
  output: z.enum(STEP_OUTPUT_MODES).optional(),
  retry: workflowRetryPolicySchema.optional(),
  onError: z.enum(STEP_ON_ERROR_MODES).optional(),
  timeoutMinutes: z.number().int().optional(),
  session: workflowSessionSpecSchema.optional(),
});

export const workflowTodoTriggerFilterSchema = z.strictObject({
  source: z.enum(['human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal']).optional(),
  department: z.string().optional(),
  assignee: z.string().optional(),
});

export const workflowTriggerSchema = z.strictObject({
  kind: z.enum(['schedule', 'manual', 'todo-status-change']),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  until: z.string().optional(),
  cronJobId: z.string().optional(),
  toStatus: z.string().optional(),
  status: z.string().optional(),
  fromStatus: z.string().optional(),
  filter: workflowTodoTriggerFilterSchema.optional(),
});

export const workflowGateSchema = z.strictObject({
  id: z.string().optional(),
  kind: z.enum(['artifact', 'flag', 'approval']),
  glob: z.string().optional(),
  flag: z.string().optional(),
  approvalRef: z.string().optional(),
  description: z.string(),
});

export const workflowConditionSchema = z.strictObject({
  path: z.string(),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string(), finiteNumber, z.boolean()]).optional(),
});

export const workflowNodeSchema = z.strictObject({
  id: z.string(),
  type: z.enum(NODE_TYPES),
  label: z.string(),
  position: workflowPositionSchema,
  actor: workflowActorSchema.optional(),
  role: z.string().optional(),
  trigger: workflowTriggerSchema.optional(),
  gate: workflowGateSchema.optional(),
  gates: z.array(workflowGateSchema).optional(),
  optional: z.boolean().optional(),
  cadence: z.string().optional(),
  instructions: z.string().optional(),
  options: workflowStepOptionsSchema.optional(),
  todoTransition: z.enum(WORK_ITEM_STATUSES).optional(),
  switchMode: z.enum(SWITCH_MODES).optional(),
  failMessage: z.string().optional(),
  waitMinutes: z.number().int().optional(),
  waitUntil: z.string().optional(),
});

export const workflowEdgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(EDGE_KINDS).optional(),
  label: z.string().optional(),
  gate: workflowGateSchema.optional(),
  when: z.array(workflowConditionSchema).optional(),
  lane: z.literal('error').optional(),
});

export const workflowLayoutSchema = z.strictObject({
  source: z.enum(['generated', 'normalized', 'manual']),
  version: z.literal(1),
});

export const workflowLoopSchema = z.strictObject({
  maxRuns: finiteNumber.optional(),
  until: z.string().optional(),
  maxRoundsPerRun: finiteNumber.optional(),
  stopWhen: z.string().optional(),
});

/** Persisted editable workflow documents, including canonical and readable legacy authority fields. */
export const workflowDefinitionSchema = z.strictObject({
  schemaVersion: z.number().int(),
  id: z.string(),
  name: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  version: z.number().int(),
  status: z.enum(['active', 'paused', 'retired']),
  orchestrator: z.string().optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  layout: workflowLayoutSchema.optional(),
  runGates: z.array(workflowGateSchema).optional(),
  loop: workflowLoopSchema.optional(),
  concurrency: finiteNumber.optional(),
  evidenceRoot: z.string().optional(),
  updatedAt: z.string().optional(),
  ...workflowAuthorityShape,
});

export type WorkflowDefinitionDocument = z.infer<typeof workflowDefinitionSchema>;

/** Raw agent authoring allows omitted positions; authoring.ts adds generated coordinates after parse. */
export const workflowAuthoringNodeSchema = workflowNodeSchema.extend({
  position: workflowPositionSchema.optional(),
});

/** Caller-authored raw graphs exclude all server provenance and authority aliases. */
export const workflowAuthoringDefinitionSchema = z.strictObject({
  schemaVersion: z.number().int().optional(),
  id: z.string(),
  name: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  version: z.number().int().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
  orchestrator: z.string().optional(),
  nodes: z.array(workflowAuthoringNodeSchema),
  edges: z.array(workflowEdgeSchema),
  runGates: z.array(workflowGateSchema).optional(),
  loop: workflowLoopSchema.optional(),
  concurrency: finiteNumber.optional(),
  evidenceRoot: z.string().optional(),
});

/** Shallow replacement patch; identity, versions, layout provenance, and authority are not caller fields. */
export const workflowDefinitionPatchSchema = workflowDefinitionSchema.pick({
  title: true,
  description: true,
  status: true,
  orchestrator: true,
  nodes: true,
  edges: true,
  runGates: true,
  loop: true,
  concurrency: true,
  evidenceRoot: true,
}).partial();

/** Direct operator routes may set recognized authority fields; provenance remains server-owned. */
export const workflowPrivilegedDefinitionPatchSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
  orchestrator: z.string().optional(),
  nodes: z.array(workflowAuthoringNodeSchema).optional(),
  edges: z.array(workflowEdgeSchema).optional(),
  runGates: z.array(workflowGateSchema).optional(),
  loop: workflowLoopSchema.optional(),
  concurrency: finiteNumber.optional(),
  evidenceRoot: z.string().optional(),
  ...workflowAuthorityShape,
});

export const workflowDirectDefinitionInputSchema = z.strictObject({
  schemaVersion: z.number().int().optional(),
  id: z.string(),
  name: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  version: z.number().int().optional(),
  status: z.enum(['active', 'paused', 'retired']).optional(),
  orchestrator: z.string().optional(),
  nodes: z.array(workflowAuthoringNodeSchema),
  edges: z.array(workflowEdgeSchema),
  runGates: z.array(workflowGateSchema).optional(),
  loop: workflowLoopSchema.optional(),
  concurrency: finiteNumber.optional(),
  evidenceRoot: z.string().optional(),
  updatedAt: z.string().optional(),
  layout: workflowLayoutSchema.optional(),
  ...workflowAuthorityShape,
});

const workflowMutateDefinitionInputSchema = workflowDirectDefinitionInputSchema;

export const workflowTriggerBindingFilterSchema = z.strictObject({
  path: z.string(),
  op: z.enum(['equals', 'notEquals', 'exists', 'matches']),
  value: z.json().optional(),
});

export const workflowSopWakeUpSchema = z.strictObject({
  kind: z.enum(['manual', 'schedule', 'todo-status', 'todo-status-change', 'event', 'poll']),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  until: z.string().optional(),
  cronJobId: z.string().optional(),
  toStatus: z.string().optional(),
  status: z.string().optional(),
  fromStatus: z.string().optional(),
  filter: z.union([
    workflowTodoTriggerFilterSchema,
    z.array(workflowTriggerBindingFilterSchema),
  ]).optional(),
  name: z.string().optional(),
  event: z.string().optional(),
  secretToken: z.string().optional(),
  command: z.string().optional(),
  intervalSeconds: finiteNumber.optional(),
  timeoutMs: finiteNumber.optional(),
  stdoutMaxBytes: finiteNumber.optional(),
  stderrMaxBytes: finiteNumber.optional(),
});

export const workflowSopStepSchema = z.strictObject({
  id: z.string().optional(),
  title: z.string().optional(),
  label: z.string().optional(),
  employee: z.string().optional(),
  engine: z.string().optional(),
  role: z.string().optional(),
  instruction: z.string().optional(),
  instructions: z.string().optional(),
  optional: z.boolean().optional(),
  options: workflowStepOptionsSchema.optional(),
  todoTransition: z.enum(WORK_ITEM_STATUSES).optional(),
});

export const workflowSopSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  wakeUp: workflowSopWakeUpSchema.optional(),
  wakeup: workflowSopWakeUpSchema.optional(),
  steps: z.array(workflowSopStepSchema),
  concurrency: finiteNumber.optional(),
});

export const workflowTriggerBindingPlanSchema = z.strictObject({
  kind: z.enum(['webhook', 'poll']),
  name: z.string(),
  event: z.string(),
  targetWorkflowId: z.string(),
  sopOwnerWorkflowId: z.string().optional(),
  filter: z.array(workflowTriggerBindingFilterSchema).optional(),
  secretToken: z.string().optional(),
  command: z.string().optional(),
  intervalSeconds: finiteNumber.optional(),
  timeoutMs: finiteNumber.optional(),
  stdoutMaxBytes: finiteNumber.optional(),
  stderrMaxBytes: finiteNumber.optional(),
  approvalWorkItemId: z.string().optional(),
  activation: z.enum(['active', 'pending_approval', 'disabled']).optional(),
});

const generatedLayoutIntentSchema = z.enum(['generated', 'normalize']);
const privilegedLayoutIntentSchema = z.enum(['generated', 'manual', 'normalize']);

const workflowDefinitionEnvelopeSchema = z.union([
  z.strictObject({ sop: workflowSopSchema, layoutIntent: generatedLayoutIntentSchema.optional() }),
  z.strictObject({ definition: workflowAuthoringDefinitionSchema, layoutIntent: generatedLayoutIntentSchema.optional() }),
]);

export const workflowPlanInputSchema = workflowDefinitionEnvelopeSchema;
export const workflowValidateInputSchema = workflowDefinitionEnvelopeSchema;
export const workflowCreateInputSchema = workflowDefinitionEnvelopeSchema;

export const workflowUpdateInputSchema = z.union([
  z.strictObject({
    workflowId: z.string(),
    expectedVersion: z.number().int().optional(),
    sop: workflowSopSchema,
    layoutIntent: generatedLayoutIntentSchema.optional(),
  }),
  z.strictObject({
    workflowId: z.string(),
    expectedVersion: z.number().int().optional(),
    patch: workflowDefinitionPatchSchema,
    layoutIntent: generatedLayoutIntentSchema.optional(),
  }),
]);

const workflowPlanTransportEnvelopeSchema = z.union([
  z.strictObject({ sop: workflowSopSchema, layoutIntent: generatedLayoutIntentSchema.optional() }),
  z.strictObject({
    definition: z.union([workflowAuthoringDefinitionSchema, workflowDirectDefinitionInputSchema]),
    layoutIntent: generatedLayoutIntentSchema.optional(),
  }),
]);

export const workflowPlanTransportSchema = workflowPlanTransportEnvelopeSchema;
export const workflowValidateTransportSchema = workflowPlanTransportEnvelopeSchema;

export const workflowDirectCreateTransportSchema = workflowDirectDefinitionInputSchema.extend({
  layoutIntent: privilegedLayoutIntentSchema.optional(),
});

export const workflowDirectUpdateTransportSchema = workflowPrivilegedDefinitionPatchSchema.extend({
  expectedVersion: z.number().int().optional(),
  layoutIntent: privilegedLayoutIntentSchema.optional(),
});

const workflowMutationMetadataShape = {
  layoutIntent: privilegedLayoutIntentSchema.optional(),
  reconcileSopTriggers: z.boolean().optional(),
  triggerBindingPlan: workflowTriggerBindingPlanSchema.optional(),
} as const;

export const workflowMutateCreateTransportSchema = z.strictObject({
  operation: z.literal('create'),
  definition: workflowMutateDefinitionInputSchema,
  ...workflowMutationMetadataShape,
});

export const workflowMutateUpdateTransportSchema = z.strictObject({
  operation: z.literal('update'),
  workflowId: z.string(),
  patch: workflowPrivilegedDefinitionPatchSchema,
  expectedVersion: z.number().int().optional(),
  ...workflowMutationMetadataShape,
});

export const workflowMutateTransportSchema = z.union([
  workflowMutateCreateTransportSchema,
  workflowMutateUpdateTransportSchema,
]);

export type WorkflowDefinitionPatch = z.infer<typeof workflowDefinitionPatchSchema>;
export type WorkflowSopInput = z.infer<typeof workflowSopSchema>;
export type WorkflowPlanInput = z.infer<typeof workflowPlanInputSchema>;
export type WorkflowValidateInput = z.infer<typeof workflowValidateInputSchema>;
export type WorkflowCreateInput = z.infer<typeof workflowCreateInputSchema>;
export type WorkflowUpdateInput = z.infer<typeof workflowUpdateInputSchema>;
export type WorkflowPlanTransport = z.infer<typeof workflowPlanTransportSchema>;
export type WorkflowValidateTransport = z.infer<typeof workflowValidateTransportSchema>;
export type WorkflowDirectCreateTransport = z.infer<typeof workflowDirectCreateTransportSchema>;
export type WorkflowDirectUpdateTransport = z.infer<typeof workflowDirectUpdateTransportSchema>;
export type WorkflowMutateCreateTransport = z.infer<typeof workflowMutateCreateTransportSchema>;
export type WorkflowMutateUpdateTransport = z.infer<typeof workflowMutateUpdateTransportSchema>;

export function parseWorkflowDefinition(input: unknown): WorkflowDefinitionDocument {
  return workflowDefinitionSchema.parse(input);
}

export function parseWorkflowDefinitionPatch(input: unknown): WorkflowDefinitionPatch {
  return workflowDefinitionPatchSchema.parse(input);
}

export function parseWorkflowSop(input: unknown): WorkflowSopInput {
  return workflowSopSchema.parse(input);
}

export function parseWorkflowPlanInput(input: unknown): WorkflowPlanInput {
  return workflowPlanInputSchema.parse(input);
}

export function parseWorkflowValidateInput(input: unknown): WorkflowValidateInput {
  return workflowValidateInputSchema.parse(input);
}

export function parseWorkflowCreateInput(input: unknown): WorkflowCreateInput {
  return workflowCreateInputSchema.parse(input);
}

export function parseWorkflowUpdateInput(input: unknown): WorkflowUpdateInput {
  return workflowUpdateInputSchema.parse(input);
}

export function parseWorkflowPlanTransport(input: unknown): WorkflowPlanTransport {
  return workflowPlanTransportSchema.parse(input);
}

export function parseWorkflowValidateTransport(input: unknown): WorkflowValidateTransport {
  return workflowValidateTransportSchema.parse(input);
}

export function parseWorkflowDirectCreateTransport(input: unknown): WorkflowDirectCreateTransport {
  return workflowDirectCreateTransportSchema.parse(input);
}

export function parseWorkflowDirectUpdateTransport(input: unknown): WorkflowDirectUpdateTransport {
  return workflowDirectUpdateTransportSchema.parse(input);
}

export function parseWorkflowMutateCreateTransport(input: unknown): WorkflowMutateCreateTransport {
  return workflowMutateCreateTransportSchema.parse(input);
}

export function parseWorkflowMutateUpdateTransport(input: unknown): WorkflowMutateUpdateTransport {
  return workflowMutateUpdateTransportSchema.parse(input);
}

export const workflowDefinitionJsonSchema = z.toJSONSchema(workflowDefinitionSchema);
export const workflowDefinitionPatchJsonSchema = z.toJSONSchema(workflowDefinitionPatchSchema);
export const workflowSopJsonSchema = z.toJSONSchema(workflowSopSchema);
export const workflowPlanInputJsonSchema = z.toJSONSchema(workflowPlanInputSchema);
export const workflowValidateInputJsonSchema = z.toJSONSchema(workflowValidateInputSchema);
export const workflowCreateInputJsonSchema = z.toJSONSchema(workflowCreateInputSchema);
export const workflowUpdateInputJsonSchema = z.toJSONSchema(workflowUpdateInputSchema);
export const workflowPlanTransportJsonSchema = z.toJSONSchema(workflowPlanTransportSchema);
export const workflowValidateTransportJsonSchema = z.toJSONSchema(workflowValidateTransportSchema);
export const workflowDirectCreateTransportJsonSchema = z.toJSONSchema(workflowDirectCreateTransportSchema);
export const workflowDirectUpdateTransportJsonSchema = z.toJSONSchema(workflowDirectUpdateTransportSchema);
export const workflowMutateCreateTransportJsonSchema = z.toJSONSchema(workflowMutateCreateTransportSchema);
export const workflowMutateUpdateTransportJsonSchema = z.toJSONSchema(workflowMutateUpdateTransportSchema);

/** Standalone generated components used to prove the compact MCP projection has
 * the exact same recursively closed object surface. Scalar/range detail remains
 * enforced by these runtime Zod schemas, not duplicated into the compact belt. */
export const workflowComponentJsonSchemas = {
  definition: z.toJSONSchema(workflowAuthoringDefinitionSchema),
  patch: z.toJSONSchema(workflowDefinitionPatchSchema),
  sop: z.toJSONSchema(workflowSopSchema),
  sopWakeUp: z.toJSONSchema(workflowSopWakeUpSchema),
  sopStep: z.toJSONSchema(workflowSopStepSchema),
  node: z.toJSONSchema(workflowAuthoringNodeSchema),
  position: z.toJSONSchema(workflowPositionSchema),
  actor: z.toJSONSchema(workflowActorSchema),
  trigger: z.toJSONSchema(workflowTriggerSchema),
  todoFilter: z.toJSONSchema(workflowTodoTriggerFilterSchema),
  bindingFilter: z.toJSONSchema(workflowTriggerBindingFilterSchema),
  gate: z.toJSONSchema(workflowGateSchema),
  options: z.toJSONSchema(workflowStepOptionsSchema),
  retry: z.toJSONSchema(workflowRetryPolicySchema),
  session: z.toJSONSchema(workflowSessionSpecSchema),
  edge: z.toJSONSchema(workflowEdgeSchema),
  condition: z.toJSONSchema(workflowConditionSchema),
  loop: z.toJSONSchema(workflowLoopSchema),
} as const;
