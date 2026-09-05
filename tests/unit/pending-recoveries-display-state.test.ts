import { describe, expect, it } from "vitest";

import { getPendingRecoveriesDisplayState } from "../../app/components/dashboard/PendingRecoveries";

describe("pending recoveries display state", () => {
  it("adopts the parent loader page and timestamp after pagination navigation", () => {
    const state = getPendingRecoveriesDisplayState({
      available: true,
      page: 2,
      pageSize: 10,
      total: 11,
      totalPages: 2,
      items: [],
    }, "2026-09-05T09:12:00.000Z");

    expect(state).toEqual({
      displayData: expect.objectContaining({ page: 2 }),
      lastUpdated: "2026-09-05T09:12:00.000Z",
    });
  });

  it("clears the timestamp when the parent loader reports unavailable data", () => {
    expect(getPendingRecoveriesDisplayState({ available: false, page: 1, pageSize: 10, total: 0, totalPages: 0, items: [] }, "2026-09-05T09:12:00.000Z")).toEqual({
      displayData: expect.objectContaining({ available: false }),
      lastUpdated: null,
    });
  });
});