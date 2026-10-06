import "./StoreCategoryMappingSelector.css";

type Mapping = {
  id: string;
  localizedDisplayName: string;
};

type Category = {
  id: string;
  localizedDisplayName: string;
  mappings?: Mapping[];
};

export default function StoreCategoryMappingSelector({
  category,
  selectedMappingIds,
  onChange,
  disabled = false,
  variant = "settings",
}: {
  category: Category | null;
  selectedMappingIds: readonly string[];
  onChange: (mappingIds: string[]) => void;
  disabled?: boolean;
  variant?: "onboarding" | "settings";
}) {
  if (!category?.mappings?.length) return null;

  const selected = new Set(selectedMappingIds);
  const toggle = (mappingId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(mappingId);
    else next.delete(mappingId);
    onChange(category.mappings
      ?.map((mapping) => mapping.id)
      .filter((mappingId) => next.has(mappingId)) ?? []);
  };

  return (
    <div
      className={`moda-store-mapping-selector moda-store-mapping-selector--${variant}`}
      role="group"
      aria-label={category.localizedDisplayName}
    >
      {category.mappings.map((mapping) => (
        <label key={mapping.id} className="moda-store-mapping-option">
          <input
            type="checkbox"
            name="mappingId"
            value={mapping.id}
            checked={selected.has(mapping.id)}
            onChange={(event) => toggle(mapping.id, event.currentTarget.checked)}
            disabled={disabled}
          />
          <span>{mapping.localizedDisplayName}</span>
        </label>
      ))}
    </div>
  );
}
