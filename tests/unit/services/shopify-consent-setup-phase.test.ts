import { describe, expect, it } from "vitest";
import {
  loadCartConsentSetupSnapshot,
  transitionCartConsentSetupPhase,
  type AdminGraphqlClient,
} from "@/services/shopify-consent/consent-activation.server";

type Phase = { value: string; type: string; compareDigest: string } | null;
function adminWithPhase(phase: Phase, mutation: object = {
  metafieldsSet: { metafields: [{ key: "cart_consent_setup_phase", value: "started" }], userErrors: [] },
}) {
  const requests: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const admin: AdminGraphqlClient = {
    async graphql(query, options) {
      requests.push({ query, variables: options?.variables });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: query.includes("ModaConsentSetupPhaseSet")
          ? mutation
          : { currentAppInstallation: {
              id: "gid://shopify/AppInstallation/1",
              metafield: { value: "false", type: "boolean" },
              setupPhase: phase,
            } } }),
      };
    },
  };
  return { admin, requests };
}

describe("Shopify app-data cart setup lifecycle", () => {
  it("distinguishes a never-started install from a completed setup", async () => {
    const initial = adminWithPhase(null);
    expect(await loadCartConsentSetupSnapshot(initial.admin)).toEqual({
      gateState: "disabled", setupPhase: "never",
    });
    const active = adminWithPhase({
      value: "active", type: "single_line_text_field", compareDigest: "shopify-digest",
    });
    expect((await loadCartConsentSetupSnapshot(active.admin)).setupPhase).toBe("active");
  });

  it("claims the first add-block operation with compareDigest:null", async () => {
    const { admin, requests } = adminWithPhase(null);
    expect(await transitionCartConsentSetupPhase(admin, "never", "started")).toBe("changed");
    expect(requests[1].query).toContain("metafields: $metafields");
    expect(requests[1].variables?.metafields).toMatchObject([{
      ownerId: "gid://shopify/AppInstallation/1", value: "started", compareDigest: null,
    }]);
  });

  it("can reconcile an existing enabled gate with a missing phase directly to active", async () => {
    const { admin, requests } = adminWithPhase(null, {
      metafieldsSet: { metafields: [{ key: "cart_consent_setup_phase", value: "active" }], userErrors: [] },
    });
    expect(await transitionCartConsentSetupPhase(admin, "never", "active")).toBe("changed");
    expect(requests[1].variables?.metafields).toMatchObject([{
      namespace: "moda_interact", key: "cart_consent_setup_phase", value: "active", compareDigest: null,
    }]);
  });

  it("sets the gate and first setup marker in one atomic Shopify mutation", async () => {
    const { admin, requests } = adminWithPhase(null, {
      metafieldsSet: { metafields: [
        { key: "cart_consent_setup_phase", value: "started" },
        { key: "cart_consent_enabled", value: "true" },
      ], userErrors: [] },
    });
    expect(await transitionCartConsentSetupPhase(admin, "never", "started", { enableGate: true }))
      .toBe("changed");
    expect(requests[1].variables?.metafields).toHaveLength(2);
  });

  it("restores only an active phase using its Shopify comparison digest", async () => {
    const { admin, requests } = adminWithPhase({
      value: "active", type: "single_line_text_field", compareDigest: "version-3",
    }, { metafieldsSet: { metafields: [{ key: "cart_consent_setup_phase", value: "restoring" }], userErrors: [] } });
    expect(await transitionCartConsentSetupPhase(admin, "active", "restoring")).toBe("changed");
    expect(requests[1].variables?.metafields).toMatchObject([{ value: "restoring", compareDigest: "version-3" }]);
  });

  it("a second concurrent attempt cannot claim the already-started setup", async () => {
    const { admin, requests } = adminWithPhase({
      value: "started", type: "single_line_text_field", compareDigest: "version-1",
    });
    expect(await transitionCartConsentSetupPhase(admin, "never", "started")).toBe("conflict");
    expect(requests).toHaveLength(1);
  });

  it("Shopify stale-object CAS collision is a safe loser, not a second add-block link", async () => {
    const { admin } = adminWithPhase(null, {
      metafieldsSet: { metafields: [], userErrors: [{ code: "STALE_OBJECT", message: "changed" }] },
    });
    expect(await transitionCartConsentSetupPhase(admin, "never", "started")).toBe("conflict");
  });

  it("preserves actual Shopify provider failure details", async () => {
    const { admin } = adminWithPhase(null, {
      metafieldsSet: { metafields: [], userErrors: [{ code: "INVALID", message: "Shopify rejected metafield" }] },
    });
    await expect(transitionCartConsentSetupPhase(admin, "never", "started"))
      .rejects.toThrow("Shopify rejected metafield");
  });
});
