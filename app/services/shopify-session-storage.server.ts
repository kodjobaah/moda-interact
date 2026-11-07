import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import {
  ShopifyOfflineTokenError,
  type LockedSessionContext,
  type SdkInstallationSessionContext,
  type ShopifyOfflineSessionCreateData,
  type ShopifyOfflineSessionRecord,
} from "@modainteract/moda-interact-shared/shopify/node";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { PrismaClient } from "@prisma/client";

export type ShopifySessionCoordinationContext = LockedSessionContext | SdkInstallationSessionContext;

export type SdkRefreshAttempt = {
  operationId: string; startedAt: number; shopId: string | null;
  tokenOutcome: "none" | "rejected" | "succeeded" | "unknown";
  credentialFingerprint: string | null; persisted: boolean;
};

type SessionBinding = {
  context: ShopifySessionCoordinationContext;
  signal: AbortSignal;
  sessionId: string | null;
  closed: boolean;
  successfulOfflineStores: number;
  persistedRefreshCredentialPair: boolean;
  persistedCredentialFingerprint: string | null;
  pendingCredentialFingerprints: Set<string>;
  tokenOutcome: "none" | "rejected" | "succeeded" | "unknown";
  sdkRefreshAttempts: SdkRefreshAttempt[];
  onSdkRefreshAttempt?: (attempt: SdkRefreshAttempt) => void;
};

type ShopifyStoredSessionRow = {
  id: string;
  shop: string;
  state: string;
  isOnline: boolean;
  scope: string | null;
  expires: Date | null;
  accessToken: string | null;
  userId: bigint | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  accountOwner: boolean | null;
  locale: string | null;
  collaborator: boolean | null;
  emailVerified: boolean | null;
  refreshToken: string | null;
  refreshTokenExpires: Date | null;
};

const sessionBinding = new AsyncLocalStorage<SessionBinding>();

function credentialFingerprint(input: {
  shop: string;
  accessToken?: string | null;
  refreshToken?: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.shop, input.accessToken ?? "", input.refreshToken ?? null]))
    .digest("hex");
}

export function recordShopifyOAuthCredentialResponse(responseBody: Uint8Array, attempt?: SdkRefreshAttempt): void {
  const binding = sessionBinding.getStore();
  if (!binding || binding.closed) throw new ShopifySessionCoordinationRequiredError();
  try {
    const payload = JSON.parse(new TextDecoder().decode(responseBody)) as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
    if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") return;
    const fingerprint = credentialFingerprint({
      shop: binding.context.shop,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
    });
    binding.pendingCredentialFingerprints.add(fingerprint);
    if (attempt) attempt.credentialFingerprint = fingerprint;
  } catch {
    // The SDK owns response parsing and its failure is reported as an unknown refresh outcome.
  }
}

export class ShopifySessionCoordinationRequiredError extends Error {
  readonly code = "COORDINATION_REQUIRED";

  constructor() {
    super("Shopify offline session access requires coordinated authentication.");
    this.name = "ShopifySessionCoordinationRequiredError";
  }
}

export function getShopifySessionBinding(): SessionBinding | undefined {
  return sessionBinding.getStore();
}

export function runWithShopifySessionBinding<T>(
  context: ShopifySessionCoordinationContext,
  work: () => Promise<T>,
  callerSignal?: AbortSignal,
  timeoutMs = 15_000,
  onSdkRefreshAttempt?: (attempt: SdkRefreshAttempt) => void,
): Promise<{
  value: T;
  successfulOfflineStores: number;
  persistedRefreshCredentialPair: boolean;
  tokenOutcome: SessionBinding["tokenOutcome"];
  sdkRefreshAttempts: SdkRefreshAttempt[];
}> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signals = [context.signal, callerSignal, timeoutController.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const binding: SessionBinding = {
    context,
    signal,
    sessionId: context.sessionId,
    closed: false,
    successfulOfflineStores: 0,
    persistedRefreshCredentialPair: false,
    persistedCredentialFingerprint: null,
    pendingCredentialFingerprints: new Set(),
    tokenOutcome: "none",
    sdkRefreshAttempts: [],
    onSdkRefreshAttempt,
  };
  const closeOnAbort = () => { binding.closed = true; };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  if (signal.aborted) closeOnAbort();

  return sessionBinding.run(binding, async () => {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ShopifyOfflineTokenError(callerSignal?.aborted ? "CANCELLED" : "DEADLINE"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (context.sessionId !== null) {
        const row = await context.transaction.session.findUnique({ where: { id: context.sessionId } }) as unknown as ShopifyStoredSessionRow | null;
        if (!row || row.id !== context.sessionId || row.shop !== context.shop || row.isOnline) {
          throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
        }
        binding.persistedCredentialFingerprint = credentialFingerprint(row);
      }
      const value = await Promise.race([
        signal.aborted
          ? Promise.reject(new ShopifyOfflineTokenError(callerSignal?.aborted ? "CANCELLED" : "DEADLINE"))
          : work(),
        aborted,
      ]);
      return {
        value,
        successfulOfflineStores: binding.successfulOfflineStores,
        persistedRefreshCredentialPair: binding.persistedRefreshCredentialPair,
        tokenOutcome: binding.tokenOutcome,
        sdkRefreshAttempts: binding.sdkRefreshAttempts,
      };
    } finally {
      binding.closed = true;
      signal.removeEventListener("abort", closeOnAbort);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
    }
  });
}

/**
 * Shopify's public SessionStorage adapter with transaction-bound offline access.
 * Online-only sessions keep the existing Prisma adapter behavior.
 */
export class CoordinatedShopifySessionStorage implements SessionStorage {
  private readonly onlineStorage: PrismaSessionStorage<PrismaClient>;

  constructor(private readonly database: PrismaClient) {
    this.onlineStorage = new PrismaSessionStorage(database);
  }

  async isReady(): Promise<boolean> {
    return this.onlineStorage.isReady();
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const binding = this.getOpenBinding();
    if (binding) {
      const row = await binding.context.transaction.session.findUnique({ where: { id } }) as unknown as ShopifyStoredSessionRow | null;
      if (!row) return undefined;
      if (row.isOnline) return this.onlineStorage.loadSession(id);
      this.assertOfflineRow(binding, row);
      const fingerprint = credentialFingerprint(row);
      if (fingerprint !== binding.persistedCredentialFingerprint) {
        throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
      }
      const session = this.rowToSession(row);
      return session;
    }

    const session = await this.onlineStorage.loadSession(id);
    if (session && !session.isOnline) throw new ShopifySessionCoordinationRequiredError();
    return session;
  }

  async storeSession(session: Session): Promise<boolean> {
    if (session.isOnline) {
      const existing = await this.database.session.findUnique({
        where: { id: session.id },
        select: { id: true, shop: true, isOnline: true },
      });
      if (existing && !existing.isOnline) {
        throw new ShopifySessionCoordinationRequiredError();
      }
      return this.onlineStorage.storeSession(session);
    }

    const binding = this.getOpenBinding();
    if (!binding) throw new ShopifySessionCoordinationRequiredError();
    this.assertOfflineSession(binding, session);

    const sessionRow = this.sessionToRow(session);
    const existing = await binding.context.transaction.session.findUnique({ where: { id: session.id } });
    if (existing?.isOnline) throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    if (existing && existing.shop !== binding.context.shop) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
    if (existing && binding.sessionId !== session.id) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
    if (!existing && binding.sessionId !== null) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
    if (existing && credentialFingerprint(existing) !== binding.persistedCredentialFingerprint) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
    const candidateFingerprint = credentialFingerprint(session);
    if (
      candidateFingerprint !== binding.persistedCredentialFingerprint &&
      !binding.pendingCredentialFingerprints.has(candidateFingerprint)
    ) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }

    await binding.context.transaction.session.upsert({
      where: { id: session.id },
      create: sessionRow,
      update: sessionRow,
    });
    if (binding.pendingCredentialFingerprints.has(candidateFingerprint)) {
      binding.persistedRefreshCredentialPair = true;
      for (const attempt of binding.sdkRefreshAttempts) {
        if (attempt.credentialFingerprint === candidateFingerprint) attempt.persisted = true;
      }
    }
    if (binding.sessionId === null) binding.sessionId = session.id;
    binding.successfulOfflineStores += 1;
    binding.persistedCredentialFingerprint = candidateFingerprint;
    binding.pendingCredentialFingerprints.clear();
    return true;
  }

  async deleteSession(id: string): Promise<boolean> {
    const binding = this.getOpenBinding();
    const row = binding
      ? await binding.context.transaction.session.findUnique({ where: { id } })
      : await this.database.session.findUnique({ where: { id } });
    if (!row) return true;
    if (row.isOnline) return this.onlineStorage.deleteSession(id);
    if (!binding) throw new ShopifySessionCoordinationRequiredError();
    this.assertOfflineRow(binding, row);
    await binding.context.transaction.session.delete({ where: { id } });
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    if (ids.length === 0) return true;
    const binding = this.getOpenBinding();
    const rows = binding
      ? await binding.context.transaction.session.findMany({
          where: { id: { in: ids } },
          take: ids.length,
        })
      : await this.database.session.findMany({
          where: { id: { in: ids } },
          select: { id: true, shop: true, isOnline: true },
          take: ids.length,
        });
    const offlineRows = rows.filter((row) => !row.isOnline);
    if (offlineRows.length > 0 && !binding) throw new ShopifySessionCoordinationRequiredError();
    if (binding) offlineRows.forEach((row) => this.assertOfflineRow(binding, row));

    const onlineIds = rows.filter((row) => row.isOnline).map((row) => row.id);
    if (onlineIds.length > 0) await this.onlineStorage.deleteSessions(onlineIds);
    if (offlineRows.length > 0) {
      await binding!.context.transaction.session.deleteMany({
        where: { id: { in: offlineRows.map((row) => row.id) } },
      });
    }
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const binding = this.getOpenBinding();
    const rows = (binding
      ? await binding.context.transaction.session.findMany({ where: { shop }, take: 25 })
      : await this.database.session.findMany({
          where: { shop },
          select: {
            id: true, shop: true, state: true, isOnline: true, scope: true,
            expires: true, accessToken: true, userId: true, firstName: true,
            lastName: true, email: true, accountOwner: true, locale: true,
            collaborator: true, emailVerified: true, refreshToken: true,
            refreshTokenExpires: true,
          },
          take: 25,
          orderBy: [{ expires: "desc" }],
        })) as unknown as ShopifyStoredSessionRow[];
    const offlineRows = rows.filter((row) => !row.isOnline);
    if (offlineRows.length > 0 && !binding) throw new ShopifySessionCoordinationRequiredError();
    if (binding) offlineRows.forEach((row) => this.assertOfflineRow(binding, row));
    return rows
      .sort((left, right) => (right.expires?.getTime() ?? 0) - (left.expires?.getTime() ?? 0))
      .map((row) => this.rowToSession(row));
  }

  private getOpenBinding(): SessionBinding | undefined {
    const binding = sessionBinding.getStore();
    if (binding?.closed) throw new ShopifySessionCoordinationRequiredError();
    return binding;
  }

  private assertOfflineSession(binding: SessionBinding, session: Session): void {
    if (session.isOnline || session.shop !== binding.context.shop) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
    if (binding.sessionId !== null && session.id !== binding.sessionId) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
  }

  private assertOfflineRow(binding: SessionBinding, row: Pick<ShopifyOfflineSessionRecord, "id" | "shop" | "isOnline">): void {
    if (row.isOnline || row.shop !== binding.context.shop || binding.sessionId === null || row.id !== binding.sessionId) {
      throw new ShopifyOfflineTokenError("SESSION_IDENTITY_CONFLICT");
    }
  }

  private sessionToRow(session: Session): ShopifyOfflineSessionCreateData {
    const params = session.toObject();
    const userId = params.onlineAccessInfo?.associated_user.id;
    return {
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope || null,
      expires: session.expires || null,
      accessToken: session.accessToken || "",
      userId: userId ? BigInt(userId) : null,
      firstName: params.onlineAccessInfo?.associated_user.first_name || null,
      lastName: params.onlineAccessInfo?.associated_user.last_name || null,
      email: params.onlineAccessInfo?.associated_user.email || null,
      accountOwner: params.onlineAccessInfo?.associated_user.account_owner || false,
      locale: params.onlineAccessInfo?.associated_user.locale || null,
      collaborator: params.onlineAccessInfo?.associated_user.collaborator || false,
      emailVerified: params.onlineAccessInfo?.associated_user.email_verified || false,
      refreshToken: params.refreshToken || null,
      refreshTokenExpires: params.refreshTokenExpires || null,
    };
  }

  private rowToSession(row: ShopifyStoredSessionRow): Session {
    const sessionParams: Record<string, string | number | boolean> = {
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.isOnline,
      userId: String(row.userId),
      firstName: String(row.firstName),
      lastName: String(row.lastName),
      email: String(row.email),
      locale: String(row.locale),
    };
    if (row.accountOwner !== null) sessionParams.accountOwner = row.accountOwner;
    if (row.collaborator !== null) sessionParams.collaborator = row.collaborator;
    if (row.emailVerified !== null) sessionParams.emailVerified = row.emailVerified;
    if (row.expires) sessionParams.expires = row.expires.getTime();
    if (row.scope) sessionParams.scope = row.scope;
    if (row.accessToken) sessionParams.accessToken = row.accessToken;
    if (row.refreshToken) sessionParams.refreshToken = row.refreshToken;
    if (row.refreshTokenExpires) sessionParams.refreshTokenExpires = row.refreshTokenExpires.getTime();
    return Session.fromPropertyArray(Object.entries(sessionParams) as [string, string | number | boolean][], true);
  }
}
