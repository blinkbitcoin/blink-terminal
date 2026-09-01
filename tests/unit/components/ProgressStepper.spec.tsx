/**
 * ProgressStepper — stage-status mapping (PR #62 review: the mobile "waiting" stage used to
 * render every step pending because "waiting" was not in the modal's stage list).
 *
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

import ProgressStepper from "../../../components/auth/ProgressStepper"

const STAGES = [
  { id: "waiting", label: "Waiting for connection" },
  { id: "connected", label: "Connected to signer" },
  { id: "signing", label: "Signing authentication" },
  { id: "syncing", label: "Loading your data" },
]

const labels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("span")).map((s) => ({
    text: s.textContent,
    cls: s.className,
  }))

describe("ProgressStepper", () => {
  it("marks the first stage current and the rest pending while waiting", () => {
    const { container } = render(
      <ProgressStepper stages={STAGES} currentStage="waiting" errorStage={null} />,
    )
    const items = labels(container)
    expect(items).toHaveLength(4)
    expect(items[0].text).toBe("Waiting for connection")
    expect(items[0].cls).toContain("text-purple-600") // current
    expect(items.slice(1).every((i) => i.cls.includes("text-gray-400"))).toBe(true) // pending
  })

  it("marks earlier stages complete and the active stage current", () => {
    const { container } = render(
      <ProgressStepper stages={STAGES} currentStage="signing" errorStage={null} />,
    )
    const items = labels(container)
    expect(items[0].cls).toContain("text-green-600") // complete
    expect(items[1].cls).toContain("text-green-600") // complete
    expect(items[2].cls).toContain("text-purple-600") // current
    expect(items[3].cls).toContain("text-gray-400") // pending
  })

  it("marks everything complete when the flow is complete", () => {
    const { container } = render(
      <ProgressStepper stages={STAGES} currentStage="complete" errorStage={null} />,
    )
    const items = labels(container)
    expect(items.every((i) => i.cls.includes("text-green-600"))).toBe(true)
  })
})
