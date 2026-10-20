import type { ReactNode } from "react";
import type { createMerchantI18n } from "../../../utils/merchant-i18n";

export type MerchantI18n = ReturnType<typeof createMerchantI18n>;
export type Translate = MerchantI18n["t"];
export type Stamp = (value: string) => ReactNode;
export type Money = (value: { amount: string | null; currency: string | null }) => string;
