import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState, type FormEvent } from "react";

import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";
import { assertActiveShop } from "@/services/shop/shop-access-policy";
import {
  getEligiblePromotionOffers,
  getCurrentPromotionSelectionState,
  getPromotionHistory,
  PromotionSelectionError,
  selectPromotionOffer,
} from "@/services/promotions/promotion.service";
import { createMerchantI18n, merchantUiContext } from "@/utils/merchant-i18n";
import { canAccessMerchantSurface, getMerchantDeniedRedirect, resolveMerchantExperienceState } from "@/services/shop/merchant-route-access-policy";
import { billingService } from "@/services/billing/billing.service";
import "./PromotionsRoute.css";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/promotions", capability: "read-promotions", redirectTo: "/app/merchant-support" });
  const subscription = await billingService.getSubscription(shop.id);
  const merchantExperienceState = resolveMerchantExperienceState({ shop, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "PROMOTIONS")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(merchantExperienceState, "PROMOTIONS") } });
  const url = new URL(request.url);
  const historyPageValue = Number(url.searchParams.get("historyPage"));
  const offerPageValue = Number(url.searchParams.get("offerPage"));
  const merchantUi = merchantUiContext(shop, session);
  const promotionLocale = createMerchantI18n(merchantUi).catalogueLocale;
  const [allOffers, promotionSelection, history] = await Promise.all([
    getEligiblePromotionOffers(shop.id, promotionLocale),
    getCurrentPromotionSelectionState(shop.id, promotionLocale),
    getPromotionHistory(shop.id, promotionLocale, historyPageValue),
  ]);
  const offerPageSize = 6;
  const offerTotalPages = Math.max(1, Math.ceil(allOffers.length / offerPageSize));
  const requestedOfferPage = Number.isInteger(offerPageValue) && offerPageValue > 0 ? offerPageValue : 1;
  const offerPage = Math.min(requestedOfferPage, offerTotalPages);

  return {
    merchantUi,
    offers: allOffers.slice((offerPage - 1) * offerPageSize, offerPage * offerPageSize),
    offersPagination: {
      page: offerPage,
      pageSize: offerPageSize,
      totalEntries: allOffers.length,
      totalPages: offerTotalPages,
    },
    promotionSelection,
    history,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  assertActiveShop(shop, { route: "/app/promotions", capability: "select-promotions", redirectTo: "/app/merchant-support" });
  const subscription = await billingService.getSubscription(shop.id);
  const merchantExperienceState = resolveMerchantExperienceState({ shop, subscription });
  if (!canAccessMerchantSurface(merchantExperienceState, "PROMOTIONS")) throw new Response(null, { status: 302, headers: { Location: getMerchantDeniedRedirect(merchantExperienceState, "PROMOTIONS") } });
  const formData = await request.formData();
  const campaignId = String(formData.get("campaignId") ?? "");
  try {
    await selectPromotionOffer(shop.id, campaignId);
    return { ok: true };
  } catch (error) {
    if (error instanceof PromotionSelectionError) {
      const messageKey = error.code === "ACTIVE_PROMOTION_ALREADY_SELECTED"
        ? "promotions.error.activeSelected"
        : error.code === "PROMOTION_NOT_ELIGIBLE"
          ? "promotions.error.notEligible"
          : "promotions.error.unavailable";
      return { ok: false, messageKey };
    }
    throw error;
  }
}

type PromotionOffer = Awaited<ReturnType<typeof loader>>["offers"][number];
type PromotionHistoryEntry = Awaited<ReturnType<typeof getPromotionHistory>>["entries"][number];

export default function PromotionsRoute() {
  const { merchantUi, offers, offersPagination, promotionSelection, history } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const i18n = createMerchantI18n(merchantUi);
  const navigation = useNavigation();
  const submitLockRef = useRef(false);
  const [submittingCampaignId, setSubmittingCampaignId] = useState<string | null>(null);
  const selectionLocked = promotionSelection?.locked === true;
  const visibleOffers = promotionSelection
    ? offers.filter((offer) => offer.id !== promotionSelection.campaignId)
    : offers;

  useEffect(() => {
    if (navigation.state === "idle") {
      submitLockRef.current = false;
      setSubmittingCampaignId(null);
    }
  }, [navigation.state]);

  const submissionInFlight = navigation.state !== "idle" || submittingCampaignId !== null;
  const guardPromotionSubmit =
    (campaignId: string) =>
    (event: FormEvent<HTMLFormElement>) => {
      if (selectionLocked || submitLockRef.current) {
        event.preventDefault();
        return;
      }

      submitLockRef.current = true;
      setSubmittingCampaignId(campaignId);
    };

  return (
    <s-page heading={i18n.t("promotions.page.title")}>
      <Breadcrumbs items={[]} current={i18n.t("promotions.page.title")} merchantUi={merchantUi} />
      <div className="moda-promotions-page">
        <section className="moda-promotions-intro">
          <span className="moda-promotions-eyebrow">{i18n.t("promotions.nav")}</span>
          <p>{i18n.t("promotions.page.description")}</p>
        </section>

        {actionData?.ok === true ? (
          <div className="moda-promotions-notice moda-promotions-notice-success" role="status">
            <span aria-hidden="true">✓</span>
            <p>{i18n.t("promotions.success")}</p>
          </div>
        ) : null}
        {actionData?.ok === false && actionData.messageKey ? (
          <div className="moda-promotions-notice moda-promotions-notice-error" role="alert">
            <span aria-hidden="true">!</span>
            <p>{i18n.t(actionData.messageKey)}</p>
          </div>
        ) : null}

        {promotionSelection?.locked === true ? (
          <section
            className="moda-promotions-lock-notice"
            role="status"
            aria-labelledby="current-promotion-heading"
          >
            <div className="moda-promotions-current-heading">
              <div>
                <span className="moda-promotions-kicker">{i18n.t("promotions.status.selected")}</span>
                <h2 id="current-promotion-heading">
                  {promotionSelection.merchantTitle ?? i18n.t("promotions.history.titleUnavailable")}
                </h2>
              </div>
              {promotionSelection.exhausted ? (
                <span className="moda-promotion-status">{i18n.t("promotions.status.exhausted")}</span>
              ) : null}
            </div>
            <div className="moda-promotions-current-balance">
              <strong>{i18n.t("promotions.remaining", { quantity: promotionSelection.remainingQuantity })}</strong>
            </div>
            <div className="moda-promotions-current-meta">
              <p>
                <strong>{i18n.t("promotions.expires")}</strong>
                <span>{i18n.formatDate(promotionSelection.expiresAt)}</span>
              </p>
              <p className="moda-promotions-current-guidance">{i18n.t("promotions.error.activeSelected")}</p>
            </div>
          </section>
        ) : null}

        <section id="promotion-offers" className="moda-promotions-panel" aria-labelledby="promotion-offers-heading">
          <div className="moda-promotions-panel-heading">
            <div>
              <span className="moda-promotions-kicker">{i18n.t("promotions.nav")}</span>
              <h2 id="promotion-offers-heading">{i18n.t("promotions.page.title")}</h2>
            </div>
          </div>

          {visibleOffers.length === 0 ? (
            <div className="moda-promotions-empty">
              <div className="moda-promotions-empty-icon" aria-hidden="true">
                <span>+</span>
              </div>
              <div>
                <h3>{i18n.t("promotions.empty")}</h3>
                <p>{i18n.t("promotions.page.description")}</p>
              </div>
            </div>
          ) : (
            <>
              <div className="moda-promotions-offer-grid">
                {visibleOffers.map((offer: PromotionOffer) => (
                  <article className="moda-promotion-card" key={offer.id}>
                    <div className="moda-promotion-card-top">
                      <span className="moda-promotion-status">
                        {i18n.t(offer.exhausted ? "promotions.status.exhausted" : offer.previouslyClaimed ? "promotions.status.claimed" : "promotions.status.available")}
                      </span>
                      <span className="moda-promotion-credit-badge">{i18n.t("promotions.credits", { quantity: offer.quantity })}</span>
                    </div>
                    <div className="moda-promotion-card-copy">
                      <h3>{offer.merchantTitle}</h3>
                      <p>{offer.merchantDescription}</p>
                    </div>
                    <div className="moda-promotion-card-meta">
                      <span><strong>{i18n.t("promotions.expires")}</strong>{i18n.formatDate(offer.expiresAt)}</span>
                      {offer.previouslyClaimed && !offer.exhausted ? <span><strong>{i18n.t("promotions.remaining", { quantity: offer.remainingQuantity })}</strong></span> : null}
                    </div>
                    <Form method="post" className="moda-promotion-card-action" onSubmit={guardPromotionSubmit(offer.id)}>
                      <input type="hidden" name="campaignId" value={offer.id} />
                      <button
                        className="moda-promotion-button"
                        type="submit"
                        disabled={selectionLocked || submissionInFlight || offer.currentlySelected}
                        aria-busy={submittingCampaignId === offer.id}
                        title={selectionLocked ? i18n.t("promotions.error.activeSelected") : undefined}
                      >
                        {offer.currentlySelected
                          ? i18n.t("promotions.status.selected")
                          : offer.previouslyClaimed ? i18n.t("promotions.action.reselect") : i18n.t("promotions.action.select")}
                      </button>
                    </Form>
                  </article>
                ))}
              </div>
              {offersPagination.totalPages > 1 ? (
                <PromotionPagination
                  currentPage={offersPagination.page}
                  totalPages={offersPagination.totalPages}
                  previousLabel={i18n.t("promotions.history.previous")}
                  nextLabel={i18n.t("promotions.history.next")}
                  previousHref={offersPagination.page > 1 ? promotionPageHref(offersPagination.page - 1, history.page, "promotion-offers") : null}
                  nextHref={offersPagination.page < offersPagination.totalPages ? promotionPageHref(offersPagination.page + 1, history.page, "promotion-offers") : null}
                />
              ) : null}
            </>
          )}
        </section>

        <details id="promotion-history" className="moda-promotions-history-disclosure">
          <summary>
            <div>
              <span className="moda-promotions-kicker">{i18n.t("promotions.history.title")}</span>
              <h2 id="promotion-history-heading">{i18n.t("promotions.history.title")}</h2>
            </div>
            <span className="moda-promotions-history-count" aria-label={`${history.totalEntries}`}>{history.totalEntries}</span>
          </summary>
          <div className="moda-promotions-history-content" aria-labelledby="promotion-history-heading">
            {history.entries.length === 0 ? (
              <div className="moda-promotions-empty moda-promotions-empty-history">
                <div className="moda-promotions-empty-icon moda-promotions-empty-icon-history" aria-hidden="true">
                  <span>↺</span>
                </div>
                <div>
                  <h3>{i18n.t("promotions.history.empty")}</h3>
                  <p>{i18n.t("promotions.empty")}</p>
                </div>
              </div>
            ) : (
              <>
                <div className="moda-promotion-history-list">
                  {history.entries.map((entry: PromotionHistoryEntry) => (
                    <article className="moda-promotion-history-card" key={entry.campaignId}>
                      <div className="moda-promotion-history-title-row">
                        <div>
                          <span className="moda-promotion-status">{historyStatusLabel(entry.status, i18n)}</span>
                          <h3>{entry.campaignTitle ?? i18n.t("promotions.history.titleUnavailable")}</h3>
                        </div>
                        <strong className="moda-promotion-history-remaining">{i18n.t("promotions.remaining", { quantity: entry.remainingQuantity })}</strong>
                      </div>
                      <div className="moda-promotion-history-stats">
                        <span>{i18n.t("promotions.history.granted", { quantity: entry.quantityGranted })}</span>
                        <span>{i18n.t("promotions.history.usedCredits", { quantity: entry.committedQuantity })}</span>
                        <span>{i18n.t("promotions.history.currentlySelected", { value: entry.currentlySelected ? i18n.t("promotions.history.yes") : i18n.t("promotions.history.no") })}</span>
                      </div>
                      <div className="moda-promotion-history-meta">
                        <p>{i18n.t("promotions.history.selectedRange", { first: formatHistoryDate(entry.firstSelectedAt, i18n), last: formatHistoryDate(entry.lastSelectedAt, i18n) })}</p>
                        <p>{i18n.t("promotions.history.usedRange", { first: formatHistoryDate(entry.firstUsedAt, i18n), last: formatHistoryDate(entry.lastUsedAt, i18n) })}</p>
                        <p><strong>{i18n.t("promotions.expires")}:</strong> {i18n.formatDate(entry.expiresAt)}</p>
                        <p>{i18n.t("promotions.history.status", { status: historyStatusLabel(entry.status, i18n) })}</p>
                      </div>
                    </article>
                  ))}
                </div>
                {history.totalPages > 1 ? (
                  <PromotionPagination
                    currentPage={history.page}
                    totalPages={history.totalPages}
                    previousLabel={i18n.t("promotions.history.previous")}
                    nextLabel={i18n.t("promotions.history.next")}
                    previousHref={history.page > 1 ? promotionPageHref(offersPagination.page, history.page - 1, "promotion-history") : null}
                    nextHref={history.page < history.totalPages ? promotionPageHref(offersPagination.page, history.page + 1, "promotion-history") : null}
                  />
                ) : null}
              </>
            )}
          </div>
        </details>
      </div>
    </s-page>
  );
}

function promotionPageHref(offerPage: number, historyPage: number, section: "promotion-offers" | "promotion-history") {
  const params = new URLSearchParams();
  if (offerPage > 1) params.set("offerPage", String(offerPage));
  if (historyPage > 1) params.set("historyPage", String(historyPage));
  const query = params.toString();
  return `/app/promotions${query ? `?${query}` : ""}#${section}`;
}

function PromotionPagination({
  currentPage,
  totalPages,
  previousLabel,
  nextLabel,
  previousHref,
  nextHref,
}: {
  currentPage: number;
  totalPages: number;
  previousLabel: string;
  nextLabel: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  return (
    <nav className="moda-promotions-pagination" aria-label={`${currentPage} / ${totalPages}`}>
      {previousHref ? <Link to={previousHref}>{previousLabel}</Link> : <span />}
      <span>{currentPage} / {totalPages}</span>
      {nextHref ? <Link to={nextHref}>{nextLabel}</Link> : <span />}
    </nav>
  );
}

function formatHistoryDate(value: Date | null, i18n: ReturnType<typeof createMerchantI18n>) {
  return value ? i18n.formatDateTime(value) : "-";
}

function historyStatusLabel(status: string, i18n: ReturnType<typeof createMerchantI18n>) {
  if (status === "EXHAUSTED") return i18n.t("promotions.status.exhausted");
  if (status === "SELECTED") return i18n.t("promotions.status.selected");
  if (status === "USED") return i18n.t("promotions.status.used");
  if (status === "EXPIRED") return i18n.t("promotions.status.expired");
  if (status === "CLOSED") return i18n.t("promotions.status.closed");
  if (status === "NO_LONGER_ELIGIBLE") return i18n.t("promotions.status.noLongerEligible");
  if (status === "REOPENED") return i18n.t("promotions.status.reopened");
  return i18n.t("promotions.status.claimed");
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs: Parameters<typeof boundary.headers>[0]) => boundary.headers(headersArgs);
