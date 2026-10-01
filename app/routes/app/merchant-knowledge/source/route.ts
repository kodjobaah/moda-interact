import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  createWebPageSource,
  editWebPageSource,
  MerchantKnowledgeError,
} from "@/services/merchant-knowledge/merchant-knowledge.server";
import { editMerchantKnowledgeUploadSource } from "@/services/merchant-knowledge/upload.server";

function validFields(form: FormData, fields: readonly string[]): boolean {
  return [...form.keys()].every((key) => fields.includes(key) && form.getAll(key).length === 1);
}

function stringField(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" ? value : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
  const form = await request.formData();
  const operation = stringField(form, "operation");
  const fields = operation === "create"
    ? ["operation", "name", "purposeKey", "dataFormatKey", "url", "languageTag"]
    : operation === "edit"
      ? ["operation", "sourceId", "name", "url", "languageTag"]
      : operation === "edit-upload"
        ? ["operation", "sourceId", "name", "languageTag"]
      : [];
  if (!fields.length || !validFields(form, fields))
    return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });

  try {
    if (operation === "create") {
      const source = await createWebPageSource({
        shopId: shop.id,
        name: stringField(form, "name"),
        purposeKey: stringField(form, "purposeKey"),
        dataFormatKey: stringField(form, "dataFormatKey"),
        url: stringField(form, "url"),
        languageTag: stringField(form, "languageTag") ?? undefined,
      });
      return Response.json({ ok: true, ...source }, { headers: { "Cache-Control": "no-store" } });
    }
    const sourceId = stringField(form, "sourceId");
    if (!sourceId || sourceId.length > 128)
      return Response.json({ ok: false, error: "INVALID_INPUT" }, { status: 400 });
    if (operation === "edit-upload") {
      await editMerchantKnowledgeUploadSource({
        shopId: shop.id,
        sourceId,
        name: stringField(form, "name"),
        languageTag: stringField(form, "languageTag"),
      });
    } else {
      await editWebPageSource({
        shopId: shop.id,
        sourceId,
        name: stringField(form, "name"),
        url: stringField(form, "url"),
        languageTag: stringField(form, "languageTag"),
      });
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MerchantKnowledgeError)
      return Response.json({ ok: false, error: error.code }, { status: error.code === "CONFLICT" ? 409 : error.code === "DENIED" ? 403 : 400 });
    throw error;
  }
}