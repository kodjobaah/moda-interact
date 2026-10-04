import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";

type Category = {
  id: string;
  localizedDisplayName: string;
  localizedDescription: string;
};
type LocalizedCategory = Pick<Category, "id" | "localizedDisplayName" | "localizedDescription"> | null;
type Profile = {
  activeCategory: LocalizedCategory;
  pendingCategory: LocalizedCategory;
  pendingSelectionGeneration: number;
  pendingState: string;
  pendingTemplate: {
    id: string;
    key: string;
    displayName: string;
    editVersion: number | null;
  } | null;
};
type SelectionResult =
  | { ok: true; pendingSelectionGeneration: number }
  | { ok: false; error: "CONFLICT" | "CATEGORY_UNAVAILABLE" | "INVALID_INPUT" };

export default function StoreProfileSection({
  categories,
  profile,
  t,
  embedded = false,
}: {
  categories: Category[];
  profile: Profile;
  t: (key: string, values?: Record<string, string | number>) => string;
  embedded?: boolean;
}) {
  const fetcher = useFetcher<SelectionResult>();
  const revalidator = useRevalidator();
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    profile.pendingCategory?.id ?? profile.activeCategory?.id ?? categories[0]?.id ?? "",
  );
  const generation = fetcher.data?.ok
    ? fetcher.data.pendingSelectionGeneration
    : profile.pendingSelectionGeneration;
  const selectionError = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const saving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) revalidator.revalidate();
  }, [fetcher.data, revalidator]);

  useEffect(() => {
    setSelectedCategoryId(
      profile.pendingCategory?.id ?? profile.activeCategory?.id ?? categories[0]?.id ?? "",
    );
  }, [profile.activeCategory?.id, profile.pendingCategory?.id, categories]);

  return (
    <section
      className={embedded ? "moda-recovery-embedded-panel" : "moda-recovery-panel"}
      aria-labelledby={embedded ? undefined : "store-profile-heading"}
      aria-label={embedded ? t("storeProfile.title") : undefined}
    >
      {!embedded ? (
        <div className="moda-recovery-panel-heading">
          <div>
            <h2 id="store-profile-heading">{t("storeProfile.title")}</h2>
            <p>{t("storeProfile.description")}</p>
          </div>
        </div>
      ) : null}

      <dl className="moda-store-profile-summary">
        <div>
          <dt>{t("storeProfile.activeCategory")}</dt>
          <dd>{profile.activeCategory?.localizedDisplayName ?? t("storeProfile.none")}</dd>
          {profile.activeCategory?.localizedDescription ? (
            <dd>{profile.activeCategory.localizedDescription}</dd>
          ) : null}
        </div>
        <div>
          <dt>{t("storeProfile.pendingCategory")}</dt>
          <dd>{profile.pendingCategory?.localizedDisplayName ?? t("storeProfile.none")}</dd>
          {profile.pendingCategory?.localizedDescription ? (
            <dd>{profile.pendingCategory.localizedDescription}</dd>
          ) : null}
        </div>
        <div>
          <dt>{t("storeProfile.pendingState")}</dt>
          <dd>{t(profile.pendingState === "PENDING_PUBLICATION" ? "storeProfile.pendingPublication" : "storeProfile.noPendingChange")}</dd>
        </div>
      </dl>

      {profile.pendingTemplate ? (
        <p className="moda-store-profile-provenance">
          {t("storeProfile.templateProvenance", {
            name: profile.pendingTemplate.displayName,
            key: profile.pendingTemplate.key,
            version: profile.pendingTemplate.editVersion ?? "-",
          })}
        </p>
      ) : null}

      {categories.length ? (
        <details className="moda-settings-disclosure moda-store-profile-disclosure">
          <summary>
            <span>{t("storeProfile.categoryLabel")}</span>
            <small>
              {profile.pendingCategory?.localizedDisplayName
                ?? profile.activeCategory?.localizedDisplayName
                ?? t("storeProfile.none")}
            </small>
          </summary>
          <div className="moda-settings-disclosure-body">
            <fetcher.Form method="post" action="/app/store-profile/category" className="moda-store-profile-form">
              <input type="hidden" name="expectedPendingSelectionGeneration" value={generation} />
              <label htmlFor="settings-store-category">
                <span>{t("storeProfile.categoryLabel")}</span>
                <select
                  id="settings-store-category"
                  name="categoryId"
                  value={selectedCategoryId}
                  onChange={(event) => setSelectedCategoryId(event.currentTarget.value)}
                  disabled={saving}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.localizedDisplayName}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={saving || !selectedCategoryId}>
                {saving ? t("storeProfile.saving") : t("storeProfile.changeCategory")}
              </button>
            </fetcher.Form>

            {selectionError ? (
              <p role="alert">{t(selectionError === "CONFLICT" ? "storeProfile.selectionConflict" : "storeProfile.saveFailed")}</p>
            ) : null}
            {fetcher.data?.ok ? <p role="status">{t("storeProfile.saved")}</p> : null}
          </div>
        </details>
      ) : (
        <p className="moda-store-profile-unavailable" role="status">
          {t("storeProfile.configurationUnavailable")}
        </p>
      )}
    </section>
  );
}
