import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTAKE_FILTERS,
  intakeFiltersQuery,
  intakeRequestsHref,
  parseIntakeFilters,
} from "./intakeQuery";

const LAWYER = "00000000-0000-4000-8000-0000000000b0";

describe("intake page URLs", () => {
  it("leaves defaults out, so the plain list is plain /intake/requests", () => {
    expect(intakeFiltersQuery(DEFAULT_INTAKE_FILTERS)).toBe("");
    expect(intakeRequestsHref()).toBe("/intake/requests");
    expect(intakeRequestsHref({ scope: "overdue", sort: "target" })).toBe(
      "/intake/requests?scope=overdue&sort=target",
    );
    expect(parseIntakeFilters(new URLSearchParams())).toEqual(
      DEFAULT_INTAKE_FILTERS,
    );
  });

  it("reads back everything it writes", () => {
    const filters = {
      tab: "resolved" as const,
      scope: "overdue" as const,
      status: "in_review" as const,
      assignee: LAWYER,
      requester: "Jane O'Neil",
      sort: "target" as const,
      q: "supplier & co",
    };
    const query = intakeFiltersQuery(filters);
    expect(query).toBe(
      `tab=resolved&scope=overdue&status=in_review&assignee=${LAWYER}&requester=Jane+O%27Neil&sort=target&q=supplier+%26+co`,
    );
    expect(parseIntakeFilters(new URLSearchParams(query))).toEqual(filters);
  });

  it("ignores values it does not know rather than failing", () => {
    expect(
      parseIntakeFilters(
        new URLSearchParams(
          "tab=all&scope=late&status=open&assignee=me&sort=name",
        ),
      ),
    ).toEqual(DEFAULT_INTAKE_FILTERS);
    expect(
      parseIntakeFilters(new URLSearchParams(`q=${"x".repeat(250)}`)).q,
    ).toHaveLength(200);
    expect(
      parseIntakeFilters(new URLSearchParams("requester=%20%20")).requester,
    ).toBeNull();
  });

  it("filters by open statuses only; closed ones have their own tabs", () => {
    for (const status of ["resolved", "cancelled"])
      expect(
        parseIntakeFilters(new URLSearchParams(`status=${status}`)).status,
      ).toBeNull();
    expect(
      parseIntakeFilters(new URLSearchParams("status=needs_information"))
        .status,
    ).toBe("needs_information");
    // A status link, such as the dashboard's, opens the list it names.
    const href = intakeRequestsHref({ status: "in_review" });
    expect(
      parseIntakeFilters(new URLSearchParams(href.split("?")[1])).status,
    ).toBe("in_review");
  });
});
