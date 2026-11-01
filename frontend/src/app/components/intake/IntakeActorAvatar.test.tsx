import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntakeActorAvatar } from "./IntakeActorAvatar";

describe("IntakeActorAvatar", () => {
  it("shows the person's initials, hidden from assistive technology", () => {
    const { container } = render(<IntakeActorAvatar name="Sam Colleague" />);
    const mark = container.firstElementChild!;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("data-actor", "person");
    expect(mark).toHaveTextContent("SC");
  });

  it("shows a neutral mark for an automatic change", () => {
    const { container } = render(<IntakeActorAvatar name={null} />);
    const mark = container.firstElementChild!;
    expect(mark).toHaveAttribute("data-actor", "automatic");
    expect(mark).toHaveTextContent("");
    expect(mark.querySelector("svg")).not.toBeNull();
  });
});
