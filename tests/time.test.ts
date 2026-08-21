import { describe, expect, it } from "vitest";
import { formatTimeRangeLabel, parseTimeRange } from "../src/domain/time.js";

describe("parseTimeRange", () => {
  it("turns inclusive calendar dates into an exclusive UTC range", () => {
    const range = parseTimeRange({
      from: "2026-08-10",
      to: "2026-08-16",
      timezone: "Asia/Shanghai",
    });
    expect(range).toEqual({
      from: "2026-08-09T16:00:00Z",
      to: "2026-08-16T16:00:00Z",
    });
  });

  it("supports relative durations", () => {
    const range = parseTimeRange({
      since: "7d",
      timezone: "Asia/Shanghai",
      now: "2026-08-20T12:00:00Z",
    });
    expect(range).toEqual({
      from: "2026-08-13T12:00:00Z",
      to: "2026-08-20T12:00:00Z",
    });
  });

  it("formats an exclusive range as inclusive calendar dates", () => {
    expect(
      formatTimeRangeLabel(
        "2026-08-09T16:00:00Z",
        "2026-08-16T16:00:00Z",
        "Asia/Shanghai",
      ),
    ).toEqual({ fromDate: "2026-08-10", toDate: "2026-08-16" });
  });
});
