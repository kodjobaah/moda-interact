import { data, type LoaderFunctionArgs } from "react-router";
import { requireRecoveryHistory } from "../recoveries/access.server";
import {
  normalizeRecoveryQuery,
  decodeRecoveryCursor,
  RecoveryQueryError,
} from "../../../services/recoveries/recovery-query.server";
import {
  readRecoveryDetail,
  readRecoveryMessages,
  readRelatedRecoveries,
} from "../../../services/recoveries/recovery-detail.server";
import { InvalidRecoveryDetailQuery } from "../../../services/recoveries/detail-cursor.server";
import type { DetailData, Section } from "./state";

async function section<T>(read: () => Promise<T | null>): Promise<Section<T>> {
  try {
    const page = await read();
    return { state: page === null ? "unavailable" : "ready", page };
  } catch (error) {
    return {
      state: error instanceof InvalidRecoveryDetailQuery ? "invalid" : "error",
      page: null,
    };
  }
}
export async function loadRecoveryDetail({
  request,
  params,
}: LoaderFunctionArgs) {
  const access = await requireRecoveryHistory(request);
  const { shopId, merchantUi, embed } = access;
  let query = normalizeRecoveryQuery(new URLSearchParams(), merchantUi);
  try {
    const candidate = normalizeRecoveryQuery(
      new URL(request.url).searchParams,
      merchantUi,
    );
    decodeRecoveryCursor(candidate, shopId);
    query = candidate;
  } catch (error) {
    if (!(error instanceof RecoveryQueryError)) throw error;
  }
  const { from, to, status, q, pageSize, cursor } = query;
  const result: DetailData = {
    merchantUi,
    embed,
    filters: { from, to, status, q, pageSize, cursor },
    detail: null,
    state: "ready",
    messages: { state: "ready", page: null },
    related: { state: "ready", page: null },
  };
  const identity = { shopId, recoveryId: params.recoveryId ?? "" };
  try {
    result.detail = await readRecoveryDetail(identity);
  } catch {
    result.state = "error";
    return data(result, { status: 503 });
  }
  if (!result.detail) {
    result.state = "unavailable";
    return data(result, { status: 404 });
  }
  [result.messages, result.related] = await Promise.all([
    section(() => readRecoveryMessages(identity)),
    section(() => readRelatedRecoveries(identity)),
  ]);
  return data(result);
}
export async function loadRecoverySection(
  args: LoaderFunctionArgs,
  kind: "messages" | "related",
) {
  const { shopId } = await requireRecoveryHistory(args.request);
  const query = new URL(args.request.url).searchParams;
  const input = {
    shopId,
    recoveryId: args.params.recoveryId ?? "",
    cursor: query.get("cursor") ?? undefined,
    window: query.get("window") ?? undefined,
  };
  const result =
    kind === "messages"
      ? await section(() => readRecoveryMessages(input))
      : await section(() => readRelatedRecoveries(input));
  return data(result, {
    status:
      result.state === "unavailable"
        ? 404
        : result.state === "invalid"
          ? 400
          : result.state === "error"
            ? 503
            : 200,
  });
}
