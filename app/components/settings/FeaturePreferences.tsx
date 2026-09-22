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
      className="moda-recovery-panel moda-recovery-feature-panel"
      aria-labelledby="merchant-features-title"
    >
      <div className="moda-recovery-section-heading">
        <h2 id="merchant-features-title">{t("merchantFeatures.title")}</h2>
        <p>{t("merchantFeatures.description")}</p>
      </div>
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
          showSubmit={false}
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
          <div className="moda-recovery-feature-grid">
            {snapshot.features.map((feature) => {
              const enabled = feature.editable
                ? (values[feature.id] ?? feature.enabled)
                : feature.effective;

              if (!feature.editable) {
                return (
                  <div
                    className="moda-recovery-toggle-card moda-recovery-core-feature is-selected"
                    key={feature.id}
                  >
                    <span
                      className="moda-recovery-core-feature-icon"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                    <span className="moda-recovery-feature-copy">
                      <strong>{feature.name}</strong>
                      {feature.description ? <p>{feature.description}</p> : null}
                      <small>
                        {t("merchantFeatures.required")} ·{" "}
                        {t("merchantFeatures.effectiveOn")}
                      </small>
                    </span>
                  </div>
                );
              }

              return (
                <label
                  className={`moda-recovery-toggle-card${enabled ? " is-selected" : ""}`}
                  key={feature.id}
                >
                  <input
                    type="checkbox"
                    data-feature-id={feature.id}
                    checked={enabled}
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
                  <span className="moda-recovery-feature-copy">
                    <strong>{feature.name}</strong>
                    {feature.description ? <p>{feature.description}</p> : null}
                    <small>
                      {t("merchantFeatures.optional")} ·{" "}
                      {t(
                        enabled
                          ? "merchantFeatures.effectiveOn"
                          : "merchantFeatures.effectiveOff",
                      )}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        </SettingsForm>
      )}
    </section>
  );
}
