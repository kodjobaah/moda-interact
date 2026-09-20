import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRevalidator } from "react-router";
import {
  createSettingsSubmission,
  type SaveState,
  type SaveReply,
} from "./submission";
export default function SettingsForm({
  children,
  revision,
  intent,
  t,
  prepare,
}: {
  children: ReactNode;
  revision: string;
  intent: "features" | "recovery";
  t: (key: string) => string;
  prepare?: (form: HTMLFormElement, body: FormData) => void;
}) {
  const revalidator = useRevalidator();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const [currentRevision, setRevision] = useState(revision);
  const controller = useRef<ReturnType<typeof createSettingsSubmission>>();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    const active = createSettingsSubmission(
      async (body) => {
        const result = await fetch("/app/settings-save", {
          method: "POST",
          body,
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (result.redirected || result.status >= 500)
          throw new Error("Unknown outcome");
        return (await result.json()) as SaveReply;
      },
      (next, reply) => {
        const fieldset = formRef.current?.querySelector(
          "fieldset[data-settings-controls]",
        ) as HTMLFieldSetElement | null;
        if (fieldset)
          fieldset.disabled =
            next.phase === "saving" || next.phase === "unknown";
        if (reply?.ok && reply.revision) {
          setRevision(reply.revision);
          void revalidatorRef.current.revalidate();
        }
        setState(next);
      },
    );
    controller.current = active;
    return () => active.dispose();
  }, []);
  const pending = state.phase === "saving" || state.phase === "unknown";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form);
    prepare?.(form, body);
    body.set("intent", intent);
    body.set("revision", currentRevision);
    body.set("operationId", crypto.randomUUID());
    controller.current!.submit(body);
  }
  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className="moda-recovery-form"
      aria-busy={pending}
    >
      <fieldset
        data-settings-controls
        disabled={pending}
        style={{
          border: 0,
          padding: 0,
          margin: 0,
          minWidth: 0,
          display: "grid",
          gap: "1rem",
        }}
      >
        {children}
        <div className="moda-recovery-form-actions">
          <button
            className="moda-recovery-save-button"
            type="submit"
            disabled={pending}
          >
            {t(
              pending
                ? "merchantFeatures.saving"
                : intent === "features"
                  ? "merchantFeatures.save"
                  : "recoverySettings.save",
            )}
          </button>
        </div>
      </fieldset>
      <p role={state.phase === "error" ? "alert" : "status"} aria-live="polite">
        {state.phase === "idle"
          ? ""
          : t(
              state.phase === "error"
                ? state.error === "CONFLICT"
                  ? "merchantFeatures.conflict"
                  : state.error === "DENIED"
                    ? "merchantFeatures.denied"
                    : "recoverySettings.invalid"
                : state.phase === "saved"
                  ? "recoverySettings.saved"
                  : state.phase === "unknown"
                    ? "merchantFeatures.unknown"
                    : "merchantFeatures.saving",
            )}
      </p>
      {state.phase === "unknown" ? (
        <button type="button" onClick={() => controller.current!.reconcile()}>
          {t("merchantFeatures.check")}
        </button>
      ) : null}
      {state.error === "CONFLICT" ? (
        <a href="/app/recovery-settings">{t("merchantFeatures.refresh")}</a>
      ) : null}
    </form>
  );
}
