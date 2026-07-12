import { describe, expect, it } from 'vitest';

function validDefinition() {
  return {
    schemaVersion: 1,
    id: 'demo',
    name: 'demo-workflow',
    title: 'Demo Workflow',
    description: 'Exercises every supported nested shape.',
    version: 3,
    status: 'active' as const,
    orchestrator: 'coordinator',
    nodes: [
      {
        id: 'wake',
        type: 'trigger' as const,
        label: 'Wake',
        position: { x: 0, y: 0 },
        trigger: {
          kind: 'todo-status-change' as const,
          toStatus: 'assigned',
          fromStatus: 'backlog',
          filter: { source: 'human', department: 'platform', assignee: 'worker' },
        },
      },
      {
        id: 'work',
        type: 'step' as const,
        label: 'Work',
        position: { x: 120, y: 160 },
        actor: { kind: 'engine' as const, ref: 'codex' },
        role: 'implement',
        gates: [{ id: 'artifact', kind: 'artifact' as const, glob: 'reports/**', description: 'Report exists' }],
        optional: false,
        cadence: 'once',
        instructions: 'Implement the change.',
        options: {
          model: 'gpt-5',
          effort: 'high' as const,
          output: 'handoff' as const,
          retry: { maxAttempts: 2, on: ['error' as const, 'interrupted' as const] },
          onError: 'fail-run' as const,
          timeoutMinutes: 30,
          session: { mode: 'fresh' as const },
        },
      },
      {
        id: 'route',
        type: 'switch' as const,
        label: 'Route',
        position: { x: 240, y: 160 },
        switchMode: 'firstMatch' as const,
      },
      {
        id: 'wait',
        type: 'wait' as const,
        label: 'Wait',
        position: { x: 360, y: 160 },
        waitMinutes: 5,
      },
      {
        id: 'stop',
        type: 'fail' as const,
        label: 'Stop',
        position: { x: 480, y: 160 },
        failMessage: 'No matching route.',
      },
    ],
    edges: [
      { id: 'e1', from: 'wake', to: 'work', kind: 'sequence' as const },
      { id: 'e2', from: 'work', to: 'route', kind: 'handoff' as const, label: 'result' },
      {
        id: 'e3',
        from: 'route',
        to: 'wait',
        kind: 'sequence' as const,
        when: [{ path: 'steps.work.status', op: 'eq' as const, value: 'completed' }],
      },
      {
        id: 'e4',
        from: 'wait',
        to: 'work',
        kind: 'loop' as const,
        gate: { kind: 'flag' as const, flag: 'done', description: 'Done flag' },
      },
      { id: 'e5', from: 'route', to: 'stop', lane: 'error' as const },
    ],
    layout: { source: 'manual' as const, version: 1 as const },
    runGates: [{ kind: 'approval' as const, approvalRef: 'operator', description: 'Approved' }],
    loop: { maxRuns: 2, until: '2026-08-01T00:00:00.000Z', maxRoundsPerRun: 3, stopWhen: 'done' },
    concurrency: 4,
    evidenceRoot: '/tmp/evidence',
    updatedAt: '2026-07-12T10:00:00.000Z',
    owner: 'workflow-owner',
    department: 'platform',
    createdBy: 'workflow-owner',
  };
}

function authoringDefinition() {
  const definition: any = structuredClone(validDefinition());
  delete definition.layout;
  delete definition.updatedAt;
  delete definition.owner;
  delete definition.department;
  delete definition.createdBy;
  return definition;
}

function validSop() {
  return {
    id: 'poll-workflow',
    name: 'poll-workflow',
    title: 'Poll workflow',
    description: 'Runs when a poll emits an event.',
    wakeUp: {
      kind: 'poll' as const,
      name: 'poll-ready',
      event: 'ready',
      filter: [{ path: 'payload.state', op: 'equals' as const, value: 'ready' }],
      command: 'printf ready',
      intervalSeconds: 60,
      timeoutMs: 5_000,
      stdoutMaxBytes: 4_096,
      stderrMaxBytes: 4_096,
    },
    steps: [{
      id: 'handle',
      title: 'Handle event',
      label: 'Handle',
      employee: 'worker',
      role: 'implement',
      instruction: 'Handle the event.',
      instructions: 'Handle the event.',
      optional: false,
      options: {
        output: 'full' as const,
        retry: { maxAttempts: 2, on: ['error' as const] },
        session: { mode: 'fresh' as const },
      },
    }],
    concurrency: 2,
  };
}

describe('workflow persisted definition schema', () => {
  it('parses the supported raw definition and canonical authority fields', async () => {
    const { parseWorkflowDefinition } = await import('../schema.js');

    expect(parseWorkflowDefinition(validDefinition())).toEqual(validDefinition());
  });

  it.each([
    ['definition mysteryMode', (value: any) => { value.mysteryMode = true; }],
    ['node', (value: any) => { value.nodes[1].extra = true; }],
    ['node onError', (value: any) => { value.nodes[1].onError = 'continue'; }],
    ['position', (value: any) => { value.nodes[1].position.extra = true; }],
    ['actor', (value: any) => { value.nodes[1].actor.extra = true; }],
    ['trigger', (value: any) => { value.nodes[0].trigger.extra = true; }],
    ['trigger filter', (value: any) => { value.nodes[0].trigger.filter.extra = true; }],
    ['gate', (value: any) => { value.nodes[1].gates[0].extra = true; }],
    ['step options', (value: any) => { value.nodes[1].options.extra = true; }],
    ['retry policy', (value: any) => { value.nodes[1].options.retry.extra = true; }],
    ['session spec', (value: any) => { value.nodes[1].options.session.extra = true; }],
    ['edge', (value: any) => { value.edges[0].extra = true; }],
    ['edge gate', (value: any) => { value.edges[3].gate.extra = true; }],
    ['edge condition', (value: any) => { value.edges[2].when[0].extra = true; }],
    ['layout metadata', (value: any) => { value.layout.extra = true; }],
    ['loop metadata', (value: any) => { value.loop.extra = true; }],
  ])('rejects unknown properties at the %s path', async (_label, mutate) => {
    const { parseWorkflowDefinition } = await import('../schema.js');
    const input = structuredClone(validDefinition());
    mutate(input);

    expect(() => parseWorkflowDefinition(input)).toThrow();
  });
});

describe('workflow patch schema', () => {
  it('accepts supported mutable fields and rejects persisted identity, provenance, and authority fields', async () => {
    const { parseWorkflowDefinitionPatch } = await import('../schema.js');
    expect(parseWorkflowDefinitionPatch({
      title: 'Renamed',
      status: 'paused',
      nodes: authoringDefinition().nodes,
      edges: authoringDefinition().edges,
      concurrency: 2,
    })).toMatchObject({ title: 'Renamed', status: 'paused', concurrency: 2 });

    for (const key of ['schemaVersion', 'id', 'name', 'version', 'layout', 'updatedAt', 'owner', 'department', 'createdBy']) {
      expect(() => parseWorkflowDefinitionPatch({ [key]: key === 'version' ? 2 : 'forged' }), key).toThrow();
    }
  });

  it('rejects unknown fields nested in replacement graph values', async () => {
    const { parseWorkflowDefinitionPatch } = await import('../schema.js');
    const patch: any = { nodes: authoringDefinition().nodes };
    patch.nodes[1].options.retry.extra = true;

    expect(() => parseWorkflowDefinitionPatch(patch)).toThrow();
  });
});

describe('workflow SOP schema', () => {
  it('parses the supported SOP shape', async () => {
    const { parseWorkflowSop } = await import('../schema.js');
    expect(parseWorkflowSop(validSop())).toEqual(validSop());
  });

  it('supports the todo-status object filter alias', async () => {
    const { parseWorkflowSop } = await import('../schema.js');
    const sop: any = validSop();
    sop.wakeUp = {
      kind: 'todo-status',
      toStatus: 'assigned',
      fromStatus: 'backlog',
      filter: { source: 'delegation', department: 'platform', assignee: 'worker' },
    };

    expect(parseWorkflowSop(sop)).toEqual(sop);
  });

  it.each([
    ['SOP', (value: any) => { value.extra = true; }],
    ['wake-up', (value: any) => { value.wakeUp.extra = true; }],
    ['wake-up filter', (value: any) => { value.wakeUp.filter[0].extra = true; }],
    ['step', (value: any) => { value.steps[0].extra = true; }],
    ['step options', (value: any) => { value.steps[0].options.extra = true; }],
  ])('rejects unknown properties in the %s shape', async (_label, mutate) => {
    const { parseWorkflowSop } = await import('../schema.js');
    const sop: any = structuredClone(validSop());
    mutate(sop);

    expect(() => parseWorkflowSop(sop)).toThrow();
  });
});

describe('workflow authoring envelope schemas', () => {
  it('rejects todoTransition in create, update, and SOP authoring', async () => {
    const {
      parseWorkflowCreateInput,
      parseWorkflowSop,
      parseWorkflowUpdateInput,
    } = await import('../schema.js');
    const definition: any = authoringDefinition();
    definition.nodes[1].todoTransition = 'in_review';
    const sop: any = validSop();
    sop.steps[0].todoTransition = 'done';

    expect(() => parseWorkflowCreateInput({ definition })).toThrow(/todoTransition.*not supported/i);
    expect(() => parseWorkflowUpdateInput({ workflowId: 'demo', patch: { nodes: definition.nodes } })).toThrow(/todoTransition.*not supported/i);
    expect(() => parseWorkflowSop(sop)).toThrow(/todoTransition.*not supported/i);
  });

  it('parses plan, validate, create, and update inputs', async () => {
    const {
      parseWorkflowCreateInput,
      parseWorkflowPlanInput,
      parseWorkflowUpdateInput,
      parseWorkflowValidateInput,
    } = await import('../schema.js');

    expect(parseWorkflowPlanInput({ definition: authoringDefinition() })).toHaveProperty('definition');
    expect(parseWorkflowValidateInput({ sop: validSop() })).toHaveProperty('sop');
    expect(parseWorkflowCreateInput({ definition: authoringDefinition() })).toHaveProperty('definition');
    expect(parseWorkflowUpdateInput({
      workflowId: 'demo',
      expectedVersion: 3,
      patch: { title: 'Updated' },
    })).toEqual({ workflowId: 'demo', expectedVersion: 3, patch: { title: 'Updated' } });
  });

  it('requires exactly one authoring representation and rejects envelope extras', async () => {
    const { parseWorkflowPlanInput, parseWorkflowUpdateInput } = await import('../schema.js');

    expect(() => parseWorkflowPlanInput({})).toThrow();
    expect(() => parseWorkflowPlanInput({ sop: validSop(), definition: authoringDefinition() })).toThrow();
    expect(() => parseWorkflowPlanInput({ sop: validSop(), extra: true })).toThrow();
    expect(() => parseWorkflowUpdateInput({ workflowId: 'demo' })).toThrow();
    expect(() => parseWorkflowUpdateInput({ workflowId: 'demo', sop: validSop(), patch: {} })).toThrow();
  });

  it('rejects caller authority injection in raw create/plan definitions and patches', async () => {
    const { parseWorkflowCreateInput, parseWorkflowPlanInput, parseWorkflowUpdateInput } = await import('../schema.js');
    const forged = authoringDefinition();
    forged.owner = 'forged-owner';

    expect(() => parseWorkflowPlanInput({ definition: forged })).toThrow();
    expect(() => parseWorkflowCreateInput({ definition: forged })).toThrow();
    expect(() => parseWorkflowUpdateInput({ workflowId: 'demo', patch: { createdBy: 'forged-owner' } })).toThrow();
  });
});

describe('workflow HTTP transport schemas', () => {
  it('accepts recognized persisted metadata on privileged plan transport and relaxed generated direct create', async () => {
    const { parseWorkflowDirectCreateTransport, parseWorkflowPlanTransport } = await import('../schema.js');
    const persisted = {
      ...validDefinition(),
      updatedAt: '2026-07-12T00:00:00.000Z',
      layout: { source: 'normalized', version: 1 },
      owner: 'jimbo',
      createdBy: 'operator',
    };
    expect(parseWorkflowPlanTransport({ definition: persisted })).toMatchObject({ definition: { owner: 'jimbo' } });
    const generated = structuredClone(validDefinition()) as any;
    delete generated.nodes[0].position;
    expect(parseWorkflowDirectCreateTransport({ ...generated, layoutIntent: 'generated' })).toMatchObject({ layoutIntent: 'generated' });
  });
  it('accepts raw plan and validate graphs before generated positions are added', async () => {
    const { parseWorkflowPlanTransport, parseWorkflowValidateTransport } = await import('../schema.js');
    const definition = authoringDefinition();
    delete definition.nodes[1].position;

    expect(parseWorkflowPlanTransport({ definition, layoutIntent: 'normalize' })).toHaveProperty('definition');
    expect(parseWorkflowValidateTransport({ definition, layoutIntent: 'generated' })).toHaveProperty('definition');
    expect(() => parseWorkflowPlanTransport({ definition, layoutIntent: 'manual' })).toThrow();
    expect(() => parseWorkflowValidateTransport({ definition, layoutIntent: 'manual' })).toThrow();
  });

  it('models privileged direct create/update authority separately from caller-safe MCP inputs', async () => {
    const { parseWorkflowDirectCreateTransport, parseWorkflowDirectUpdateTransport } = await import('../schema.js');
    const create: any = authoringDefinition();
    delete create.schemaVersion;
    delete create.version;
    delete create.status;
    create.ownerEmployee = 'legacy-owner';
    create.workflowDepartment = 'platform';
    create.critical = true;
    create.layoutIntent = 'manual';

    expect(parseWorkflowDirectCreateTransport(create)).toMatchObject({
      ownerEmployee: 'legacy-owner',
      workflowDepartment: 'platform',
      critical: true,
      layoutIntent: 'manual',
    });
    expect(parseWorkflowDirectUpdateTransport({
      title: 'Updated',
      expectedVersion: 3,
      layoutIntent: 'normalize',
      ownerDepartment: 'platform',
      requiresCooApproval: true,
    })).toMatchObject({ expectedVersion: 3, ownerDepartment: 'platform' });
  });

  it('parses strict mutate create/update transports including trigger reconciliation metadata', async () => {
    const { parseWorkflowMutateCreateTransport, parseWorkflowMutateUpdateTransport } = await import('../schema.js');
    const triggerBindingPlan = {
      kind: 'poll' as const,
      name: 'poll-ready',
      event: 'ready',
      targetWorkflowId: 'demo',
      sopOwnerWorkflowId: 'demo',
      command: 'printf ready',
      intervalSeconds: 60,
      filter: [{ path: 'payload.state', op: 'equals' as const, value: 'ready' }],
    };

    expect(parseWorkflowMutateCreateTransport({
      operation: 'create',
      definition: validDefinition(),
      layoutIntent: 'generated',
      reconcileSopTriggers: true,
      triggerBindingPlan,
    })).toHaveProperty('definition');
    expect(parseWorkflowMutateUpdateTransport({
      operation: 'update',
      workflowId: 'demo',
      expectedVersion: 3,
      patch: { title: 'Updated' },
      layoutIntent: 'normalize',
      reconcileSopTriggers: true,
      triggerBindingPlan,
    })).toHaveProperty('patch');
  });

  it('rejects unknown transport fields before route code can spread them', async () => {
    const {
      parseWorkflowDirectCreateTransport,
      parseWorkflowDirectUpdateTransport,
      parseWorkflowMutateCreateTransport,
      parseWorkflowMutateUpdateTransport,
      parseWorkflowPlanTransport,
    } = await import('../schema.js');

    expect(() => parseWorkflowPlanTransport({ definition: authoringDefinition(), mysteryMode: true })).toThrow();
    expect(() => parseWorkflowDirectCreateTransport({ ...authoringDefinition(), mysteryMode: true })).toThrow();
    expect(() => parseWorkflowDirectUpdateTransport({ nodes: [{ ...authoringDefinition().nodes[1], onError: 'continue' }] })).toThrow();
    expect(() => parseWorkflowMutateCreateTransport({ operation: 'create', definition: { ...validDefinition(), mysteryMode: true } })).toThrow();
    expect(() => parseWorkflowMutateUpdateTransport({ operation: 'update', workflowId: 'demo', patch: { mysteryMode: true } })).toThrow();
  });
});

describe('JSON Schema projections', () => {
  it('exports closed projections generated from each runtime schema', async () => {
    const schema = await import('../schema.js');
    const projections = [
      schema.workflowDefinitionJsonSchema,
      schema.workflowDefinitionPatchJsonSchema,
      schema.workflowSopJsonSchema,
      schema.workflowPlanInputJsonSchema,
      schema.workflowValidateInputJsonSchema,
      schema.workflowCreateInputJsonSchema,
      schema.workflowUpdateInputJsonSchema,
    ];

    for (const projection of projections) {
      expect(projection).toBeTypeOf('object');
      expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    }
    expect(schema.workflowDefinitionJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect((schema.workflowDefinitionJsonSchema as any).properties.nodes.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    for (const branch of (schema.workflowPlanInputJsonSchema as any).anyOf) {
      expect(branch).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});
