import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ImageLightbox, type ImageLightboxItem } from "../image-lightbox"

const gallery: ImageLightboxItem[] = [
  { id: "one", url: "/images/one.png", name: "one.png" },
  { id: "two", url: "/images/two.png", name: "two.png" },
]

function LightboxHarness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true)
  const [image, setImage] = useState(gallery[0])
  if (!open) return null
  return (
    <ImageLightbox
      image={image}
      gallery={gallery}
      onNavigate={setImage}
      onClose={() => {
        setOpen(false)
        onClose()
      }}
    />
  )
}

function previewImage(): HTMLImageElement {
  return screen.getByTestId("attachment-lightbox-image") as HTMLImageElement
}

describe("ImageLightbox gestures", () => {
  it("pinches between 1x and 4x as two pointers move apart and together", () => {
    render(<LightboxHarness />)
    const image = previewImage()
    expect(image.style.touchAction).toBe("none")
    image.setPointerCapture = () => { throw new DOMException("Synthetic pointer") }

    fireEvent.pointerDown(image, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(image, { pointerId: 2, clientX: 100, clientY: 0 })
    fireEvent.pointerMove(image, { pointerId: 2, clientX: 200, clientY: 0 })
    expect(Number(image.dataset.zoom)).toBeGreaterThan(1)

    fireEvent.pointerMove(image, { pointerId: 2, clientX: 50, clientY: 0 })
    expect(image.dataset.zoom).toBe("1")

    fireEvent.pointerMove(image, { pointerId: 2, clientX: 1000, clientY: 0 })
    expect(image.dataset.zoom).toBe("4")
  })

  it("handles ctrl-wheel zoom without allowing browser page zoom", () => {
    render(<LightboxHarness />)
    const image = previewImage()
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 60,
      ctrlKey: true,
      deltaY: -120,
    })

    fireEvent(image, wheel)

    expect(Number(image.dataset.zoom)).toBeGreaterThan(1)
    expect(wheel.defaultPrevented).toBe(true)
  })

  it("resets zoom and pan when navigating to another image", () => {
    render(<LightboxHarness />)
    let image = previewImage()
    fireEvent.click(screen.getByTestId("attachment-lightbox-zoom"))
    fireEvent.pointerDown(image, { pointerId: 1, clientX: 20, clientY: 30 })
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 45, clientY: 65 })
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 45, clientY: 65 })
    expect(image.style.transform).toContain("translate(25px, 35px)")

    fireEvent.click(screen.getByTestId("attachment-lightbox-next"))

    image = previewImage()
    expect(image.getAttribute("alt")).toBe("two.png")
    expect(image.dataset.zoom).toBe("1")
    expect(image.style.transform).toContain("translate(0px, 0px)")
  })

  it("navigates and wraps with horizontal swipes while fitted", () => {
    render(<LightboxHarness />)
    let image = previewImage()

    fireEvent.pointerDown(image, { pointerId: 1, clientX: 220, clientY: 120 })
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 100, clientY: 124 })
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 100, clientY: 124 })
    image = previewImage()
    expect(image.getAttribute("alt")).toBe("two.png")

    fireEvent.pointerDown(image, { pointerId: 2, clientX: 220, clientY: 120 })
    fireEvent.pointerMove(image, { pointerId: 2, clientX: 100, clientY: 124 })
    fireEvent.pointerUp(image, { pointerId: 2, clientX: 100, clientY: 124 })
    expect(previewImage().getAttribute("alt")).toBe("one.png")
  })

  it("closes on a downward swipe while fitted", async () => {
    render(<LightboxHarness />)
    const image = previewImage()

    fireEvent.pointerDown(image, { pointerId: 1, clientX: 120, clientY: 100 })
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 124, clientY: 220 })
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 124, clientY: 220 })

    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox")).toBeNull())
  })

  it("pans instead of closing on the same downward drag while zoomed", () => {
    render(<LightboxHarness />)
    fireEvent.click(screen.getByTestId("attachment-lightbox-zoom"))
    const image = previewImage()

    fireEvent.pointerDown(image, { pointerId: 1, clientX: 120, clientY: 100 })
    fireEvent.pointerMove(image, { pointerId: 1, clientX: 124, clientY: 220 })
    fireEvent.pointerUp(image, { pointerId: 1, clientX: 124, clientY: 220 })

    expect(screen.getByTestId("attachment-lightbox")).toBeTruthy()
    expect(image.style.transform).toContain("translate(4px, 120px)")
  })
})

describe("ImageLightbox close controls", () => {
  it("unmounts from the close button", async () => {
    render(<LightboxHarness />)
    fireEvent.click(screen.getByLabelText("Close preview"))
    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox")).toBeNull())
  })

  it("unmounts from Escape", async () => {
    render(<LightboxHarness />)
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox")).toBeNull())
  })

  it("unmounts from a backdrop tap", async () => {
    render(<LightboxHarness />)
    fireEvent.pointerDown(screen.getByTestId("attachment-lightbox"), { pointerId: 1 })
    await waitFor(() => expect(screen.queryByTestId("attachment-lightbox")).toBeNull())
  })
})
