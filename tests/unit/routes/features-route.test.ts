import { describe, expect, it } from "vitest";

import {
  action,
  FEATURES_REDIRECT,
  loader,
} from "../../../app/routes/app/features/route";

describe("legacy conversation-features route", () => {
  it("redirects legacy GET navigation to the canonical Recovery Settings section", () => {
    const response = loader();

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(FEATURES_REDIRECT);
    expect(FEATURES_REDIRECT).toBe(
      "/app/recovery-settings#conversation-features",
    );
  });

  it("does not accept legacy feature mutations and redirects POSTs to the canonical surface", () => {
    const response = action();

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(FEATURES_REDIRECT);
  });
});
