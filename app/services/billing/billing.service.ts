import type {
  PrismaClient,
  Subscription,
} from "@prisma/client";

import type {
  BillingProvider,
  MerchantShopifyLifecycleState,
  MerchantShopifySubscriptionState,
  BillingVerificationFailure,
  MerchantBillingReadInput,
  MerchantHomeBillingReadInput,
} from "./billing.types";

import {
  ShopifyBillingProvider,
} from "./providers/shopify-billing.provider";
import {
  deriveBillingPeriodPhase,
  SubscriptionSyncService,
} from "./subscription-sync.service";

export { deriveBillingPeriodPhase };

import prisma from "../../db.server";
import {
  BillingPlanResolutionService,
  type OperationalBillingPlanResolution,
} from "./billing-plan-resolution.service";
import { SubscriptionReadService } from "./subscription-read.service";
import { MerchantBillingPresentationReadService } from "./merchant-billing-presentation.server";
import {
  HostedPlanChangeService,
  type HostedPlanChangeReturnResult,
  type HostedPlanVerificationFence,
} from "./hosted-plan-change.service";
import {
  SubscriptionActivationService,
} from "./subscription-activation.service";
import type {
  CompletedFreeActivation,
  FreeActivationResult,
  InitialFreeActivationToken,
} from "./subscription-activation.service";
import { RecoveryCreditPurchaseRequestService } from "./recovery-credit-purchase-request.service";
import { ShopifyBillingOperationService } from "./shopify-billing-operation.service";
import {
  defaultTranslationDispatch,
  SubscriptionEndedNotificationService,
  type TranslationDispatch,
} from "./subscription-ended-notification.service";

export { renderSubscriptionEndedMessage } from "./subscription-ended-notification.service";

export { INITIAL_BILLING_RETRY_DELAY_MS } from "./billing-retry-policy";
export type {
  CompletedFreeActivation,
  FreeActivationResult,
  InitialFreeActivationToken,
  InitialPaidActivationToken,
} from "./subscription-activation.service";
export type {
  HostedPlanChangeReturnResult,
  HostedPlanVerificationFence,
} from "./hosted-plan-change.service";

export class BillingService {
  private readonly planResolutionService: BillingPlanResolutionService;
  private readonly subscriptionReadService: SubscriptionReadService;
  private readonly billingOperationService: ShopifyBillingOperationService;
  private readonly subscriptionActivationService: SubscriptionActivationService;
  private readonly hostedPlanChangeService: HostedPlanChangeService;
  private readonly recoveryCreditPurchaseRequestService: RecoveryCreditPurchaseRequestService;
  private readonly presentationReadService: MerchantBillingPresentationReadService;
  private readonly subscriptionSyncService: SubscriptionSyncService;

  constructor(
    private readonly provider: BillingProvider =
      new ShopifyBillingProvider(),
    private readonly database: PrismaClient = prisma,
    dispatchTranslation: TranslationDispatch =
      defaultTranslationDispatch,
  ) {
    this.planResolutionService = new BillingPlanResolutionService(database);
    this.subscriptionReadService = new SubscriptionReadService(provider, database);
    this.billingOperationService = new ShopifyBillingOperationService(database);
    this.subscriptionActivationService = new SubscriptionActivationService(
      database,
      this.planResolutionService,
      this.billingOperationService,
    );
    this.hostedPlanChangeService = new HostedPlanChangeService(
      database,
      this.billingOperationService,
    );
    this.recoveryCreditPurchaseRequestService = new RecoveryCreditPurchaseRequestService(
      provider,
      database,
      this.planResolutionService,
      this.billingOperationService,
    );
    this.presentationReadService = new MerchantBillingPresentationReadService(provider, database);
    const subscriptionEndedNotificationService = new SubscriptionEndedNotificationService(
      database,
      dispatchTranslation,
    );
    this.subscriptionSyncService = new SubscriptionSyncService(
      provider,
      database,
      this.planResolutionService,
      this.subscriptionActivationService,
      subscriptionEndedNotificationService,
      this.billingOperationService,
    );
  }

  private async resolveOrMaterializeBillingPlan(
    planHandle: string,
  ): Promise<OperationalBillingPlanResolution> {
    return this.planResolutionService.resolveOrMaterializeBillingPlan(planHandle);
  }

  async prepareFreeActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    return this.subscriptionActivationService.prepareFreeActivation(shopId, planHandle);
  }

  async preparePaidActivation(
    shopId: string,
    planHandle: string,
  ): Promise<FreeActivationResult | null> {
    return this.subscriptionActivationService.preparePaidActivation(shopId, planHandle);
  }

  async getSubscriptionProjection(shopId: string) {
    return this.subscriptionReadService.getSubscriptionProjection(shopId);
  }

  async scheduleInitialFreeReconciliationIfCurrent({
    shopId,
    expected,
    nextReconcileAt,
    verificationFailure = null,
  }: {
    shopId: string;
    expected: InitialFreeActivationToken;
    nextReconcileAt: Date;
    verificationFailure?: BillingVerificationFailure;
  }): Promise<{ subscriptionId: string; nextReconcileAt: Date } | null> {
    return this.subscriptionActivationService.scheduleInitialFreeReconciliationIfCurrent({
      shopId,
      expected,
      nextReconcileAt,
      verificationFailure,
    });
  }

  async completeFreeActivation(
    shopId: string,
    requestedPlanHandle: string,
  ): Promise<CompletedFreeActivation | null> {
    return this.subscriptionActivationService.completeFreeActivation(shopId, requestedPlanHandle);
  }

async getSubscription(
  shopId: string,
) {
    return this.subscriptionReadService.getSubscription(shopId);
}

  async getMerchantShopifySubscriptionState(
    shopId: string,
  ): Promise<MerchantShopifySubscriptionState> {
    return this.subscriptionReadService.getMerchantShopifySubscriptionState(shopId);
  }

  async getHostedPlanVerificationFence(
    shopId: string,
  ): Promise<HostedPlanVerificationFence | null> {
    return this.hostedPlanChangeService.getHostedPlanVerificationFence(shopId);
  }

  async recordHostedPlanChangeReturn({
    shopId,
    requestedPlanHandle,
    state,
    verificationFence,
  }: {
    shopId: string;
    requestedPlanHandle: string;
    state: MerchantShopifySubscriptionState;
    verificationFence: HostedPlanVerificationFence | null;
  }): Promise<{ result: HostedPlanChangeReturnResult; subscriptionId: string | null; nextReconcileAt: Date | null }> {
    return this.hostedPlanChangeService.recordHostedPlanChangeReturn({
      shopId,
      requestedPlanHandle,
      state,
      verificationFence,
    });
  }

  async recordHostedPlanVerificationFailure(
    shopId: string,
    verificationFence: HostedPlanVerificationFence | null,
    verificationFailure: Exclude<BillingVerificationFailure, null>,
  ): Promise<{ subscriptionId: string; nextReconcileAt: Date } | null> {
    return this.hostedPlanChangeService.recordHostedPlanVerificationFailure(
      shopId,
      verificationFence,
      verificationFailure,
    );
  }

  async getMerchantShopifyLifecycleState(
    shopId: string,
  ): Promise<MerchantShopifyLifecycleState> {
    return this.subscriptionReadService.getMerchantShopifyLifecycleState(shopId);
  }

  readMerchantBillingPresentation(input: MerchantBillingReadInput) {
    return this.presentationReadService.readOptions(input);
  }

  readMerchantHomeBillingPresentation(input: MerchantHomeBillingReadInput) {
    return this.presentationReadService.readHome(input);
  }

  async requestRecoveryCreditPack(shopId: string, intent: string, purchaseId: string, eventHandle: string) {
    return this.recoveryCreditPurchaseRequestService.requestRecoveryCreditPack(
      shopId,
      intent,
      purchaseId,
      eventHandle,
    );
  }


  async syncSubscription(
    shopId: string,
    expectedInitialSelection?: InitialFreeActivationToken,
  ): Promise<Subscription | null> {
    return this.subscriptionSyncService.syncSubscription(
      shopId,
      expectedInitialSelection,
    );
  }
}


export const billingService =
  new BillingService();