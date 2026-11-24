import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODA_SUPPORTED_LANGUAGE_TAGS } from "@modainteract/moda-interact-shared/internationalization";

const mocks = vi.hoisted(() => ({ sender: vi.fn() }));
vi.mock("../../app/services/recoveries/recovery-follow-up-sender.server", () => ({
  trustedRecoverySenderWaba: mocks.sender,
}));
vi.mock("../../app/db.server", () => ({ default: {} }));

import {
  ONBOARDING_TEMPLATE_PURPOSES,
  ensureOnboardingRecoveryTemplatesBestEffort,
} from "../../app/services/recoveries/onboarding-template-assignments.server";

const shopId = "cm123456789012345678901234";
const WABA = "1234567890";
const languages = [...MODA_SUPPORTED_LANGUAGE_TAGS];
const registrationIds = Object.fromEntries(languages.map((language) => [language, `reg-${language}`]));

function scenario(options: { missing?: boolean; existing?: "complete" | "partial"; drift?: boolean } = {}) {
  const rows: Array<{id:string; purpose:string; languageTag:string; providerAccountId:string; metaRegistrationId:string}> = [];
  let activePurpose = "INITIAL_NO_OFFER";
  if (options.existing) {
    for (const language of options.existing === "complete" ? languages : languages.slice(0, 1)) {
      for (const purpose of ONBOARDING_TEMPLATE_PURPOSES) {
        rows.push({id:`existing-${purpose}-${language}`, purpose, languageTag:language, providerAccountId:WABA, metaRegistrationId: `existing-reg-${language}`});
      }
    }
  }
  const registration = (language: string) => ({
    id: registrationIds[language], wabaId: WABA, providerTemplateName:"shopify_recovery",
    providerLanguageCode: language.replace("-", "_"), providerTemplateId:`meta-${language}`,
    providerStatus:"APPROVED", submissionState:"SUBMITTED", lastReconciledAt:new Date(),
    failureCode:null, driftDetectedAt:null,
    category:"MARKETING", lastObservedCategory:"MARKETING",
    lastObservedContentHash:createHash("sha256").update("[]").digest("hex"),
    submittedContentHash:createHash("sha256").update(language).digest("hex"), componentsSnapshot:[], parameterBindingsSnapshot:{},
    locale:{ definitionId:"definition-1", status:"REVIEWED", languageTag:language,
      providerLanguageCode: language.replace("-", "_"), contentHash:createHash("sha256").update(language).digest("hex"),
      reviewedAt:new Date(), reviewedByAdminId:"admin-1" },
  });
  const tx = {
    $queryRaw:vi.fn().mockResolvedValue([]),
    shop:{findUnique:vi.fn().mockResolvedValue({id:shopId,platform:"SHOPIFY",status:"ACTIVE",onboardingCompleted:true})},
    whatsAppTemplateVariant:{
      findMany:vi.fn(async ({where}:{where:{purpose:string;enabled?:boolean}})=>rows.filter((row)=>row.purpose===where.purpose)), findUnique:vi.fn().mockResolvedValue(null),
      createMany:vi.fn(async ({data}:{data:Array<{purpose:string;languageTag:string;providerAccountId:string;metaRegistrationId:string}>})=>{
        for(const item of data)rows.push({id:`new-${item.purpose}-${item.languageTag}`,...item});
        return {count:data.length};
      }),
    },
    whatsAppTemplatePublicationOperation:{findFirst:vi.fn(async({where}:{where:unknown})=> {
      activePurpose = (where as {AND:Array<{scopeSnapshot:{path:string[];equals:string}}>}).AND[1]!.scopeSnapshot.equals;
      return options.missing ? null : ({
      id:"publication-1",definitionId:"definition-1",requestedByAdminId:"admin-1",
      totalTargets:20,succeededTargets:20,failedTargets:0,
      completedAt:new Date(),scopeSnapshot:{schemaVersion:1,scope:{mode:"all"},wabaId:WABA,
        purpose:activePurpose,
        registrationIds, sourceFingerprint:"a".repeat(64), previewFingerprint:"b".repeat(64)},
    });
    }),
    create:vi.fn().mockResolvedValue({id:"new-publication"}),
    },
    whatsAppTemplatePublicationTarget:{
      createMany:vi.fn().mockResolvedValue({count:20}),
      findMany:vi.fn(async ({where}:{where:{newVariantId:{in:string[]}}})=>
        rows.filter((row)=>where.newVariantId.in.includes(row.id)).map((row)=>({
          newVariantId:row.id, languageTag:row.languageTag, metaRegistrationId:row.metaRegistrationId,
        }))),
    },
    whatsAppTemplateDefinition:{findUnique:vi.fn(async()=>({
      id:"definition-1",kind:"META_RECOVERY",purpose:activePurpose.startsWith("INITIAL_")?"INITIAL":"FOLLOW_UP",
      offerType:activePurpose.replace(/^(INITIAL|FOLLOW_UP)_/, ""),status:"PUBLISHED",
      providerTemplateName:"shopify_recovery",category:"MARKETING",publishedAt:new Date(),retiredAt:null,
    }))},
    whatsAppTemplateMetaRegistration:{findMany:vi.fn(async()=> languages.map((l)=>({
      ...registration(l), ...(options.drift && l===languages[0] ? {providerStatus:"REJECTED"}:{}),
    })))},
  };

  const db = { $transaction:vi.fn(async(fn:(tx:unknown)=>Promise<unknown>)=>fn(tx)) };
  const reporter = {report:vi.fn().mockResolvedValue({incidentKey:"key",recorded:true,occurrenceCount:1,status:"OPEN"})};
  return {tx,db,rows,reporter};
}

beforeEach(()=>{vi.clearAllMocks();mocks.sender.mockResolvedValue(WABA);});

describe("Shopify onboarding recovery template provisioning",()=>{
  it("records actionable incidents for every purpose without an all-shop published default",async()=>{
    const f=scenario({missing:true});
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    expect(f.reporter.report).toHaveBeenCalledTimes(ONBOARDING_TEMPLATE_PURPOSES.length);
    expect(f.reporter.report.mock.calls[0]?.[0]).toMatchObject({
      category:"WHATSAPP_TEMPLATE_PROVISIONING",reasonCode:"NO_APPROVED_DEFAULT",shopId,
      resourceKey:`${shopId}:INITIAL_NO_OFFER`,
    });
    expect(f.reporter.report.mock.calls[0]?.[0].errorMessage).toContain("Publish > All currently eligible shops");
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
  });

  it("inherits the six latest complete all-shop publications and creates 120 locale assignments",async()=>{
    const f=scenario();
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    expect(f.rows).toHaveLength(ONBOARDING_TEMPLATE_PURPOSES.length*languages.length);
    expect(f.tx.whatsAppTemplateVariant.createMany).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplatePublicationTarget.createMany).toHaveBeenCalledTimes(6);
    expect(f.tx.whatsAppTemplatePublicationOperation.create).toHaveBeenCalledTimes(6);
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("rejects a drifted Meta registration and creates an incident without partial assignments",async()=>{
    const f=scenario({drift:true});
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    expect(f.tx.whatsAppTemplatePublicationTarget.createMany).not.toHaveBeenCalled();
    expect(f.reporter.report.mock.calls[0]?.[0].reasonCode).toBe("DEFAULT_NOT_APPLICABLE");
  });

  it("is idempotent when a shop resumes onboarding after successful provisioning",async()=>{
    const f=scenario();
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    expect(f.rows).toHaveLength(120);
    expect(f.tx.whatsAppTemplateVariant.createMany).toHaveBeenCalledTimes(6);
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("does not overwrite existing complete merchant-specific template assignments",async()=>{
    const f=scenario({existing:"complete"});
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    expect(f.reporter.report).not.toHaveBeenCalled();
  });

  it("flags a partial shop assignment instead of mixing versions or providers",async()=>{
    const f=scenario({existing:"partial"});
    await ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter);
    expect(f.tx.whatsAppTemplateVariant.createMany).not.toHaveBeenCalled();
    expect(f.reporter.report.mock.calls[0]?.[0].reasonCode).toBe("ASSIGNMENT_REVIEW_REQUIRED");
  });

  it("reports sender misconfiguration without changing onboarding or writing templates",async()=>{
    const f=scenario();mocks.sender.mockRejectedValueOnce(new Error("provider config failure"));
    await expect(ensureOnboardingRecoveryTemplatesBestEffort(shopId,f.db as never,f.reporter)).resolves.toBeUndefined();
    expect(f.reporter.report).toHaveBeenCalledOnce();
    expect(f.reporter.report.mock.calls[0]?.[0].reasonCode).toBe("SENDER_CONFIGURATION_UNAVAILABLE");
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
});
