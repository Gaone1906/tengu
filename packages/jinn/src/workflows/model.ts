import { isProxy } from 'node:util/types';
import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCE_ROOT_SEGMENTS = new Set(['input', 'trigger', 'run', 'nodes']);
const INVALID_INPUT = Symbol('invalid-workflow-input');

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

type OwnDescriptors = ReturnType<typeof Object.getOwnPropertyDescriptors>;

function normalizeArray(descriptors: OwnDescriptors, ancestors: WeakSet<object>): JsonValue | typeof INVALID_INPUT {
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) return INVALID_INPUT;
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || keys.length !== lengthDescriptor.value + 1) return INVALID_INPUT;
  const normalized: JsonValue[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return INVALID_INPUT;
    const child = normalizeJson(descriptor.value, ancestors);
    if (child === INVALID_INPUT) return INVALID_INPUT;
    normalized.push(child);
  }
  return normalized;
}

function normalizeRecord(descriptors: OwnDescriptors, ancestors: WeakSet<object>): JsonValue | typeof INVALID_INPUT {
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || FORBIDDEN_PATH_SEGMENTS.has(key)) return INVALID_INPUT;
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return INVALID_INPUT;
    const child = normalizeJson(descriptor.value, ancestors);
    if (child === INVALID_INPUT) return INVALID_INPUT;
    Object.defineProperty(normalized, key, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return normalized;
}

function normalizeJson(value: unknown, ancestors: WeakSet<object>): JsonValue | typeof INVALID_INPUT {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_INPUT;
  if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) return INVALID_INPUT;
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return INVALID_INPUT;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  try {
    return array
      ? normalizeArray(descriptors, ancestors)
      : normalizeRecord(descriptors, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function normalizeInput(value: unknown): unknown {
  try {
    return normalizeJson(value, new WeakSet<object>());
  } catch {
    return INVALID_INPUT;
  }
}

function normalizedSchema<T extends z.ZodType>(schema: T) {
  return z.preprocess(normalizeInput, schema);
}

export const jsonValueSchema = normalizedSchema(z.custom<JsonValue>(
  (value) => value !== INVALID_INPUT,
  { message: 'Value must be bounded, accessor-free JSON data' },
));

const finiteNumberSchema = z.number().finite();
export const workflowIdSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, 'Invalid workflow ID')
  .refine((id) => id !== 'events', 'Reserved workflow ID');
export const nodeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, 'Invalid node ID');
const edgeIdSchema = z.string().min(1).max(128);
const portSchema = z.string().min(1);
const pathSegmentSchema = z.string()
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'Invalid path segment')
  .refine((segment) => !FORBIDDEN_PATH_SEGMENTS.has(segment), 'Unsafe path segment');

const bindingPathSchema = z.string().min(1).max(256).superRefine((path, context) => {
  const segments = path.split('.');
  if (segments.length > 16) context.addIssue({ code: 'custom', message: 'Binding path may contain at most 16 segments' });
  if (segments.length > 1 && SOURCE_ROOT_SEGMENTS.has(segments[0]!)) {
    context.addIssue({ code: 'custom', message: 'Binding paths are relative to their source' });
  }
  for (const [index, segment] of segments.entries()) {
    const result = pathSegmentSchema.safeParse(segment);
    if (!result.success) context.addIssue({ code: 'custom', message: result.error.issues[0]!.message, path: [index] });
  }
});

function bindingWithFixed<T extends z.ZodType>(fixedValueSchema: T) {
  return z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('fixed'), value: fixedValueSchema }),
    z.strictObject({ source: z.literal('input'), path: bindingPathSchema }),
    z.strictObject({ source: z.literal('trigger'), path: bindingPathSchema }),
    z.strictObject({ source: z.literal('run'), path: bindingPathSchema }),
    z.strictObject({ source: z.literal('node'), nodeId: nodeIdSchema, path: bindingPathSchema }),
  ]);
}

export const bindingSchema = bindingWithFixed(jsonValueSchema);
const stringBindingSchema = bindingWithFixed(z.string());
const effortBindingSchema = bindingWithFixed(z.enum(['low', 'medium', 'high', 'xhigh']));

type InferredBinding = z.infer<typeof bindingSchema>;
export type Binding<T extends JsonValue = JsonValue> =
  | (Omit<Extract<InferredBinding, { source: 'fixed' }>, 'value'> & { value: T })
  | Exclude<InferredBinding, { source: 'fixed' }>;
const workflowOutputFieldSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean', 'string[]']),
  required: z.boolean(),
  description: z.string().optional(),
});
const workflowOutputSchema = z.strictObject({
  fields: z.record(pathSegmentSchema, workflowOutputFieldSchema),
  allowAdditionalFields: z.boolean(),
});
const workflowRetrySchema = z.strictObject({
  attempts: z.number().int().min(1).max(5),
  delaySeconds: finiteNumberSchema.int().nonnegative(),
  backoff: z.enum(['fixed', 'exponential']),
});
const triggerConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('schedule'), cron: z.string(), timezone: z.string() }),
  z.strictObject({
    kind: z.literal('event'),
    eventName: z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
    tokenRef: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('todo-status'), status: z.string() }),
  z.strictObject({ kind: z.literal('workflow-call') }),
]);
const triggerNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('trigger'),
  name: z.string().min(1).max(80),
  config: triggerConfigSchema,
});
const employeeNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('employee'),
  name: z.string().min(1).max(80),
  config: z.strictObject({
    employee: stringBindingSchema,
    prompt: z.string().refine((value) => utf8Bytes(value) <= MAX_PROMPT_BYTES, 'Prompt must be at most 32 KiB'),
    engine: stringBindingSchema.optional(),
    model: stringBindingSchema.optional(),
    effort: effortBindingSchema.optional(),
    output: workflowOutputSchema.optional(),
    retry: workflowRetrySchema.optional(),
    timeoutMinutes: finiteNumberSchema.int().min(1).max(1440).optional(),
  }),
});
const conditionPredicateSchema = z.strictObject({
  left: bindingSchema,
  operator: z.enum(['equals', 'not-equals', 'exists', 'not-exists', 'contains', 'gt', 'gte', 'lt', 'lte', 'in']),
  right: bindingSchema.optional(),
});
const conditionCaseSchema = z.strictObject({
  port: portSchema,
  label: z.string(),
  all: z.array(conditionPredicateSchema).max(10),
});
const conditionConfigSchema = z.strictObject({
  cases: z.array(conditionCaseSchema).max(10),
  defaultPort: portSchema,
}).superRefine((config, context) => {
  const ports = new Set<string>();
  for (const [index, item] of config.cases.entries()) {
    if (ports.has(item.port)) context.addIssue({ code: 'custom', message: 'Duplicate Condition port', path: ['cases', index, 'port'] });
    ports.add(item.port);
  }
  if (ports.has(config.defaultPort)) context.addIssue({ code: 'custom', message: 'Condition default port must be unique', path: ['defaultPort'] });
});
const conditionNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('condition'),
  name: z.string().min(1).max(80),
  config: conditionConfigSchema,
});
const mergeNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('merge'),
  name: z.string().min(1).max(80),
  config: z.strictObject({ mode: z.literal('wait-all') }),
});
const approvalNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('approval'),
  name: z.string().min(1).max(80),
  config: z.strictObject({ description: z.string(), approver: stringBindingSchema.optional() }),
});
const waitConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('duration'), minutes: finiteNumberSchema.int().min(1).max(43_200) }),
  z.strictObject({ mode: z.literal('until'), timestamp: stringBindingSchema }),
]);
const waitNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('wait'),
  name: z.string().min(1).max(80),
  config: waitConfigSchema,
});
const endNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('end'),
  name: z.string().min(1).max(80),
  config: z.strictObject({ result: z.enum(['success', 'failure']), message: z.string().optional(), output: bindingSchema.optional() }),
});
const rawWorkflowNodeSchema = z.discriminatedUnion('type', [
  triggerNodeSchema,
  employeeNodeSchema,
  conditionNodeSchema,
  mergeNodeSchema,
  approvalNodeSchema,
  waitNodeSchema,
  endNodeSchema,
]);
export const workflowNodeSchema = normalizedSchema(rawWorkflowNodeSchema);
const workflowEdgeSchema = z.strictObject({
  id: edgeIdSchema,
  from: z.strictObject({ nodeId: nodeIdSchema, port: portSchema }),
  to: z.strictObject({ nodeId: nodeIdSchema, port: z.literal('input') }),
});
const workflowInputFieldSchema = z.strictObject({
  key: pathSegmentSchema,
  label: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'employee', 'engine', 'model']),
  required: z.boolean(),
  default: z.union([z.string(), finiteNumberSchema, z.boolean(), z.null()]).optional(),
  description: z.string().optional(),
});
const workflowUiSchema = z.strictObject({
  positions: z.record(nodeIdSchema, z.strictObject({ x: finiteNumberSchema, y: finiteNumberSchema })),
});
const graphShape = {
  inputs: z.array(workflowInputFieldSchema).optional(),
  nodes: z.array(rawWorkflowNodeSchema).max(100),
  edges: z.array(workflowEdgeSchema).max(300),
  ui: workflowUiSchema.optional(),
} as const;
type GraphValue = {
  inputs?: Array<{ key: string }>;
  nodes: Array<{ id: string }>;
  edges: Array<{ id: string }>;
};

function addDuplicateIssues(value: GraphValue, context: z.RefinementCtx): void {
  for (const [items, label, path] of [
    [value.nodes, 'node ID', 'nodes'],
    [value.edges, 'edge ID', 'edges'],
    [value.inputs ?? [], 'input key', 'inputs'],
  ] as const) {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const key = 'key' in item ? item.key : item.id;
      if (seen.has(key)) context.addIssue({ code: 'custom', message: `Duplicate ${label}: ${key}`, path: [path, index] });
      seen.add(key);
    }
  }
}

function addSizeIssue(value: unknown, context: z.RefinementCtx, label: string): void {
  let bytes: number;
  try {
    bytes = utf8Bytes(JSON.stringify(value));
  } catch {
    context.addIssue({ code: 'custom', message: `${label} must be serializable JSON` });
    return;
  }
  if (bytes > MAX_DEFINITION_BYTES) {
    context.addIssue({ code: 'custom', message: `${label} must be at most 256 KiB` });
  }
}

const rawWorkflowDraftSchema = z.strictObject(graphShape).superRefine((value, context) => {
  addDuplicateIssues(value, context);
  addSizeIssue(value, context, 'Workflow draft');
});
export const workflowDraftSchema = normalizedSchema(rawWorkflowDraftSchema);

const rawWorkflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: workflowIdSchema,
  title: z.string().min(1).max(120),
  description: z.string().optional(),
  revision: z.number().int().min(1),
  enabled: z.boolean(),
  retiredAt: z.string().optional(),
  ...graphShape,
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((value, context) => {
  addDuplicateIssues(value, context);
  if (value.enabled && value.retiredAt !== undefined) {
    context.addIssue({ code: 'custom', message: 'A retired Workflow cannot be enabled', path: ['enabled'] });
  }
  addSizeIssue(value, context, 'Workflow definition');
});
export const workflowDefinitionSchema = normalizedSchema(rawWorkflowDefinitionSchema);

export type WorkflowOutputSchema = z.infer<typeof workflowOutputSchema>;
export type WorkflowInputField = z.infer<typeof workflowInputFieldSchema>;
export type TriggerNode = z.infer<typeof triggerNodeSchema>;
export type EmployeeNode = z.infer<typeof employeeNodeSchema>;
export type ConditionPredicate = z.infer<typeof conditionPredicateSchema>;
export type ConditionNode = z.infer<typeof conditionNodeSchema>;
export type MergeNode = z.infer<typeof mergeNodeSchema>;
export type ApprovalNode = z.infer<typeof approvalNodeSchema>;
export type WaitNode = z.infer<typeof waitNodeSchema>;
export type EndNode = z.infer<typeof endNodeSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowId = WorkflowDefinition['id'];

export interface WorkflowNodeOutput {
  text: string;
  fields: Record<string, JsonValue>;
  employeeId?: string;
  engine?: string;
  model?: string;
  sessionId?: string;
}
