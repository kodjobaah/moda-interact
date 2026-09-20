import { useState } from "react";
import SettingsForm from "./SettingsForm";
import type { loadFeaturePreferences } from "@/services/feature-preferences/feature-preferences.server";
type Snapshot = Awaited<ReturnType<typeof loadFeaturePreferences>>;
export default function FeaturePreferences({
  snapshot,
  t,
}: {
  snapshot: Snapshot & { denied?: boolean };
  t: (key: string) => string;
}) {
  const [values, setValues] = useState(
    Object.fromEntries(snapshot.features.map((f) => [f.id, f.enabled])),
  );
  return (
    <section
      className="moda-recovery-panel"
      aria-labelledby="merchant-features-title"
    >
      <h2 id="merchant-features-title">{t("merchantFeatures.title")}</h2>
      <p>{t("merchantFeatures.description")}</p>
      {!snapshot.features.length ? (
        <p role={snapshot.denied ? "alert" : "status"}>
          {t(
            snapshot.denied
              ? "merchantFeatures.denied"
              : "merchantFeatures.empty",
          )}
        </p>
      ) : (
        <SettingsForm
          revision={snapshot.revision}
          intent="features"
          t={t}
          prepare={(form, body) =>
            body.set(
              "preferences",
              JSON.stringify(
                Array.from(
                  form.querySelectorAll<HTMLInputElement>(
                    "input[data-feature-id]",
                  ),
                ).map((input) => ({
                  featureId: input.dataset.featureId!,
                  enabled: input.checked,
                })),
              ),
            )
          }
        >
          {snapshot.features.map((feature) => (
            <label
              className={`moda-recovery-toggle-card${(feature.editable ? values[feature.id] : feature.effective) ? " is-selected" : ""}${!feature.editable ? " is-disabled" : ""}`}
              key={feature.id}
            >
              <input
                type="checkbox"
                data-feature-id={feature.editable ? feature.id : undefined}
                checked={
                  feature.editable
                    ? (values[feature.id] ?? feature.enabled)
                    : feature.effective
                }
                disabled={!feature.editable}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setValues((previous) => ({
                    ...previous,
                    [feature.id]: checked,
                  }));
                  event.currentTarget.form?.requestSubmit();
                }}
              />
              <span className="moda-recovery-toggle" aria-hidden="true">
                <span />
              </span>
              <span>
                <strong>{feature.name}</strong>
                <br />
                <small>{feature.key}</small>
                {feature.description ? <p>{feature.description}</p> : null}
                <small>
                  {t(
                    feature.editable
                      ? "merchantFeatures.optional"
                      : "merchantFeatures.required",
                  )}{" "}
                  ·{" "}
                  {t(
                    feature.effective
                      ? "merchantFeatures.effectiveOn"
                      : "merchantFeatures.effectiveOff",
                  )}
                </small>
              </span>
            </label>
          ))}
        </SettingsForm>
      )}
    </section>
  );
}
