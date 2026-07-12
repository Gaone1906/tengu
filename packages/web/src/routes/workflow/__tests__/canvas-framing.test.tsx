import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const flow = vi.hoisted(() => ({
  fitView: vi.fn(async () => true),
  getZoom: vi.fn(() => 0.8),
  setCenter: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  moveStart: undefined as ((event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }) => void) | undefined,
}))

vi.mock("@xyflow/react", async () => {
  const React = await import("react")
  return {
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    BaseEdge: () => null,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    MiniMap: () => null,
    ReactFlow: ({
      children,
      onInit,
      onMoveStart,
    }: {
      children?: React.ReactNode
      onInit?: (instance: typeof flow) => void
      onMoveStart?: typeof flow.moveStart
    }) => {
      flow.moveStart = onMoveStart
      React.useEffect(() => { onInit?.(flow) }, [])
      return <div data-testid="react-flow-stub">{children}</div>
    },
    getBezierPath: () => ["", 0, 0],
    useReactFlow: () => flow,
    useViewport: () => ({ x: 0, y: 0, zoom: flow.getZoom() }),
  }
})

vi.mock("../node-components", () => ({ jinnNodeTypes: {} }))

import { WorkflowCanvas, type CanvasNode } from "../canvas"

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = []
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this)
  }

  emit(target: Element, width: number, height: number) {
    const rect = {
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }
    this.callback([{ target, contentRect: rect } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

const nodes: CanvasNode[] = [
  {
    id: "trigger",
    kind: "trigger",
    title: "Trigger",
    role: "trigger",
    who: "schedule",
    status: "passed",
    isCurrent: false,
    gates: [],
    position: { x: 0, y: 0 },
  },
  {
    id: "failed",
    kind: "step",
    title: "Failed",
    role: "verify",
    who: "codex",
    status: "blocked",
    isCurrent: true,
    gates: [],
    position: { x: 420, y: 0 },
  },
]

async function emitSize(observer: ControlledResizeObserver, target: Element, width: number, height: number) {
  await act(async () => {
    observer.emit(target, width, height)
    await Promise.resolve()
  })
}

function clearViewportCalls() {
  flow.fitView.mockClear()
  flow.setCenter.mockClear()
}

describe("WorkflowCanvas responsive framing ownership", () => {
  beforeEach(() => {
    ControlledResizeObserver.instances = []
    clearViewportCalls()
    flow.moveStart = undefined
    flow.getZoom.mockReset().mockReturnValue(0.8)
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver)
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(max-width: 767px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reframes once per breakpoint/orientation class and never for same-class size or geometry churn", async () => {
    const view = render(
      <WorkflowCanvas
        nodes={nodes}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
        controls
      />,
    )

    await waitFor(() => expect(ControlledResizeObserver.instances).toHaveLength(1))
    const observer = ControlledResizeObserver.instances[0]
    const canvas = screen.getByTestId("wf-canvas")

    // The first observed desktop class owns one initial readable frame.
    clearViewportCalls()
    await emitSize(observer, canvas, 1440, 900)
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1))
    expect(flow.setCenter).not.toHaveBeenCalled()

    // Pixel-only resize inside the same class must preserve the user's viewport.
    clearViewportCalls()
    await emitSize(observer, canvas, 1280, 800)
    expect(flow.fitView).not.toHaveBeenCalled()
    expect(flow.setCenter).not.toHaveBeenCalled()

    // Explicit Fit all remains user-owned; subsequent harmless churn cannot
    // silently reopen it or steal a pan/zoom adjustment.
    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    expect(flow.fitView).toHaveBeenCalledTimes(1)
    clearViewportCalls()
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, position: { x: node.position!.x + 24, y: node.position!.y + 24 } }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
        controls
      />,
    )
    await emitSize(observer, canvas, 1360, 820)
    expect(flow.fitView).not.toHaveBeenCalled()
    expect(flow.setCenter).not.toHaveBeenCalled()

    // Desktop → mobile opens the failed/current node at readable scale once.
    await emitSize(observer, canvas, 390, 844)
    await waitFor(() => expect(flow.setCenter).toHaveBeenCalledTimes(1))
    expect(flow.fitView).not.toHaveBeenCalled()
    clearViewportCalls()
    await emitSize(observer, canvas, 375, 812)
    expect(flow.setCenter).not.toHaveBeenCalled()
    expect(flow.fitView).not.toHaveBeenCalled()

    // Orientation is semantic even without crossing the mobile breakpoint.
    await emitSize(observer, canvas, 700, 390)
    await waitFor(() => expect(flow.setCenter).toHaveBeenCalledTimes(1))
    expect(flow.fitView).not.toHaveBeenCalled()

    // Mobile → desktop and desktop portrait → landscape each reframe once.
    clearViewportCalls()
    await emitSize(observer, canvas, 1024, 1366)
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1))
    expect(flow.setCenter).not.toHaveBeenCalled()
    clearViewportCalls()
    await emitSize(observer, canvas, 1440, 900)
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1))
    expect(flow.setCenter).not.toHaveBeenCalled()
  })

  it("preserves a user pan across repeated desktop status ticks", async () => {
    const view = render(
      <WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} framingKey="run-1" />,
    )
    await waitFor(() => expect(ControlledResizeObserver.instances).toHaveLength(1))
    const observer = ControlledResizeObserver.instances[0]
    const canvas = screen.getByTestId("wf-canvas")
    await emitSize(observer, canvas, 1440, 900)
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1))
    clearViewportCalls()

    act(() => flow.moveStart?.(new MouseEvent("mousedown"), { x: 80, y: 40, zoom: 1.1 }))
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, status: node.id === "failed" ? "running" : "passed", isCurrent: node.id === "failed" }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
      />,
    )
    await act(async () => { await Promise.resolve() })
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, status: "passed", isCurrent: false }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
      />,
    )
    await act(async () => { await Promise.resolve() })

    expect(flow.fitView).not.toHaveBeenCalled()
    expect(flow.setCenter).not.toHaveBeenCalled()
  })

  it("preserves explicit zoom and Fit ownership across repeated status ticks", async () => {
    const view = render(
      <WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} framingKey="run-1" controls />,
    )
    await waitFor(() => expect(ControlledResizeObserver.instances).toHaveLength(1))
    const observer = ControlledResizeObserver.instances[0]
    const canvas = screen.getByTestId("wf-canvas")
    await emitSize(observer, canvas, 1440, 900)
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1))
    clearViewportCalls()

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(flow.zoomIn).toHaveBeenCalledTimes(1)
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, status: "running", isCurrent: node.id === "failed" }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
        controls
      />,
    )
    await act(async () => { await Promise.resolve() })
    expect(flow.fitView).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Fit all" }))
    expect(flow.fitView).toHaveBeenCalledTimes(1)
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, status: "passed", isCurrent: false }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
        controls
      />,
    )
    await act(async () => { await Promise.resolve() })
    expect(flow.fitView).toHaveBeenCalledTimes(1)
  })

  it("preserves a user pan across repeated mobile status ticks", async () => {
    const view = render(
      <WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} framingKey="run-1" />,
    )
    await waitFor(() => expect(ControlledResizeObserver.instances).toHaveLength(1))
    const observer = ControlledResizeObserver.instances[0]
    const canvas = screen.getByTestId("wf-canvas")
    await emitSize(observer, canvas, 390, 844)
    await waitFor(() => expect(flow.setCenter).toHaveBeenCalledTimes(1))
    clearViewportCalls()

    act(() => flow.moveStart?.(new TouchEvent("touchstart"), { x: 20, y: 120, zoom: 0.9 }))
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, status: "running", isCurrent: node.id === "failed" }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
      />,
    )
    await act(async () => { await Promise.resolve() })
    view.rerender(
      <WorkflowCanvas
        nodes={nodes.map((node) => ({ ...node, status: "passed", isCurrent: false }))}
        selectedId={null}
        onSelect={vi.fn()}
        framingKey="run-1"
      />,
    )
    await act(async () => { await Promise.resolve() })

    expect(flow.setCenter).not.toHaveBeenCalled()
    expect(flow.fitView).not.toHaveBeenCalled()
  })

  it("cancels an in-flight automatic desktop focus when the user claims the viewport", async () => {
    let resolveFit: ((value: boolean) => void) | undefined
    flow.fitView.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFit = resolve }))
    flow.getZoom.mockReturnValue(0.4)
    render(<WorkflowCanvas nodes={nodes} selectedId={null} onSelect={vi.fn()} framingKey="run-1" />)
    await waitFor(() => expect(ControlledResizeObserver.instances).toHaveLength(1))
    const observer = ControlledResizeObserver.instances[0]
    const canvas = screen.getByTestId("wf-canvas")
    await emitSize(observer, canvas, 1440, 900)
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1))

    act(() => flow.moveStart?.(new MouseEvent("wheel"), { x: 10, y: 10, zoom: 1.2 }))
    await act(async () => {
      resolveFit?.(true)
      await Promise.resolve()
    })

    expect(flow.setCenter).not.toHaveBeenCalled()
  })
})
