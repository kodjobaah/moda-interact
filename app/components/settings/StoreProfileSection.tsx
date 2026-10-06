import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import StoreCategoryMappingSelector from "@/components/store-profile/StoreCategoryMappingSelector";

type Category = {
  id: string;
  localizedDisplayName: string;
  localizedDescription: string;
  mappings?: Array<{ id: string; localizedDisplayName: string }>;
};
type LocalizedCategory = Pick<Category, "id" | "localizedDisplayName" | "localizedDescription"> | null;
type Profile = {
  activeCategory: LocalizedCategory;
  pendingCategory: LocalizedCategory;
  pendingSelectionGeneration: number;
  activeMappingIds: string[];
  pendingMappingIds: string[];
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

function mappingIdsForCategory(
  categoryId: string,
  categories: Category[],
  pendingCategoryId: string | null | undefined,
  activeCategoryId: string | null | undefined,
  pendingMappingIds: string[],
  activeMappingIds: string[],
): string[] {
  const available = new Set(
    categories.find((category) => category.id === categoryId)?.mappings?.map((mapping) => mapping.id) ?? [],
  );
  const candidates = categoryId === pendingCategoryId
    ? pendingMappingIds
    : categoryId === activeCategoryId
      ? activeMappingIds
      : [];
  return candidates.filter((mappingId) => available.has(mappingId));
}

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
  const initialCategoryId = profile.pendingCategory?.id ?? profile.activeCategory?.id ?? categories[0]?.id ?? "";
  const [selectedCategoryId, setSelectedCategoryId] = useState(initialCategoryId);
  const [selectedMappingIds, setSelectedMappingIds] = useState(() =>
    mappingIdsForCategory(
      initialCategoryId,
      categories,
      profile.pendingCategory?.id,
      profile.activeCategory?.id,
      profile.pendingMappingIds,
      profile.activeMappingIds,
    ),
  );
  const actionGeneration = fetcher.data?.ok
    ? fetcher.data.pendingSelectionGeneration
    : null;
  const generation = Math.max(
    profile.pendingSelectionGeneration,
    actionGeneration ?? profile.pendingSelectionGeneration,
  );
  const waitingForLoader = actionGeneration !== null
    && profile.pendingSelectionGeneration < actionGeneration;
  const selectionError = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const saving = fetcher.state !== "idle" || waitingForLoader;

  useEffect(() => {
    const categoryId = profile.pendingCategory?.id ?? profile.activeCategory?.id ?? categories[0]?.id ?? "";
    setSelectedCategoryId(categoryId);
    setSelectedMappingIds(mappingIdsForCategory(
      categoryId,
      categories,
      profile.pendingCategory?.id,
      profile.activeCategory?.id,
      profile.pendingMappingIds,
      profile.activeMappingIds,
    ));
  }, [
    profile.activeCategory?.id,
    profile.pendingCategory?.id,
    profile.activeMappingIds,
    profile.pendingMappingIds,
    categories,
  ]);

  const selectedCategory = categories.find((category) => category.id === selectedCategoryId) ?? null;
  const persistedCategoryId = profile.pendingCategory?.id ?? profile.activeCategory?.id ?? "";
  const persistedMappingIds = mappingIdsForCategory(
    persistedCategoryId,
    categories,
    profile.pendingCategory?.id,
    profile.activeCategory?.id,
    profile.pendingMappingIds,
    profile.activeMappingIds,
  );
  const selectedMappingSet = new Set(selectedMappingIds);
  const hasUnsavedChanges = selectedCategoryId !== persistedCategoryId
    || selectedMappingIds.length !== persistedMappingIds.length
    || persistedMappingIds.some((mappingId) => !selectedMappingSet.has(mappingId));
  const selectCategory = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    setSelectedMappingIds(mappingIdsForCategory(
      categoryId,
      categories,
      profile.pendingCategory?.id,
      profile.activeCategory?.id,
      profile.pendingMappingIds,
      profile.activeMappingIds,
    ));
  };

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
                  onChange={(event) => selectCategory(event.currentTarget.value)}
                  disabled={saving}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.localizedDisplayName}
                    </option>
                  ))}
                </select>
              </label>
              <StoreCategoryMappingSelector
                category={selectedCategory}
                selectedMappingIds={selectedMappingIds}
                onChange={setSelectedMappingIds}
                disabled={saving}
              />
              <button type="submit" disabled={saving || !selectedCategoryId || !hasUnsavedChanges}>
                {saving ? t("storeProfile.saving") : t("storeProfile.changeCategory")}
              </button>
            </fetcher.Form>

            {selectionError ? (
              <p role="alert">{t(selectionError === "CONFLICT" ? "storeProfile.selectionConflict" : "storeProfile.saveFailed")}</p>
            ) : null}
            {fetcher.data?.ok && waitingForLoader ? (
              <p role="status">{t("storeProfile.saved")}</p>
            ) : null}
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
