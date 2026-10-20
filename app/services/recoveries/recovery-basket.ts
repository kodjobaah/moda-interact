/** A snapshot of the checkout event, never a live catalogue lookup. */
export type RecoveryBasketItem = {
  title: string | null;
  variant: string | null;
  quantity: number | null;
  unitPrice: string | null;
  imageUrl: string | null;
};
export type RecoveryBasket = {
  items: RecoveryBasketItem[];
  currency: string | null;
  recoveryTotal: string | null;
  unavailableReason: "missing" | "invalid" | "partial" | null;
};

const text = (value: unknown, max = 240): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const decimal = (value: unknown): string | null =>
  typeof value === "string" && /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value) ? value : null;

function safeImage(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function projectRecoveryBasket(
  raw: unknown, currency: string | null, recoveryTotal: string | null,
): RecoveryBasket {
  const base = { currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null, recoveryTotal };
  if (raw === null || raw === undefined) return { ...base, items: [], unavailableReason: "missing" };
  if (!Array.isArray(raw)) return { ...base, items: [], unavailableReason: "invalid" };
  let partial = raw.length > 50;
  const items: RecoveryBasketItem[] = [];
  for (const candidate of raw.slice(0, 50)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      partial = true;
      continue;
    }
    const row = candidate as Record<string, unknown>;
    const title = text(row.title), variant = text(row.variantTitle);
    const quantity = Number.isSafeInteger(row.quantity) && (row.quantity as number) > 0 &&
      (row.quantity as number) <= 100000 ? row.quantity as number : null;
    const unitPrice = decimal(row.price);
    if (!title || quantity === null || (row.price !== null && row.price !== undefined && !unitPrice)) partial = true;
    items.push({ title, variant, quantity, unitPrice, imageUrl: safeImage(row.imageUrl) });
  }
  return { ...base, items, unavailableReason: partial ? "partial" : null };
}
