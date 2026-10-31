import SettingsForm from "@/components/settings/SettingsForm";

export default function AiResponseDelaySettings({
  revision,
  value,
  t,
}: {
  revision: string;
  value: number;
  t: (key: string) => string;
}) {
  return (
    <SettingsForm revision={revision} intent="ai-response-delay" t={t}>
      <section aria-labelledby="ai-response-delay-heading">
        <div className="moda-recovery-panel-heading">
          <div>
            <h2 id="ai-response-delay-heading">
              {t("recoverySettings.aiResponseDelay.title")}
            </h2>
            <p id="ai-response-delay-help">
              {t("recoverySettings.aiResponseDelay.help")}
            </p>
          </div>
        </div>
        <label
          className="moda-recovery-number-control"
          htmlFor="aiResponseDelayMinutes"
        >
          <span>{t("recoverySettings.aiResponseDelay.label")}</span>
          <input
            id="aiResponseDelayMinutes"
            name="aiResponseDelayMinutes"
            type="number"
            min="0"
            max="30"
            step="1"
            required
            defaultValue={value}
            aria-describedby="ai-response-delay-help"
          />
        </label>
      </section>
    </SettingsForm>
  );
}
