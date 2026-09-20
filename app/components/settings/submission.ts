export type SaveReply = {
  ok: boolean;
  operationId: string;
  revision?: string;
  error?: string;
};
export type SaveState = {
  phase: "idle" | "saving" | "unknown" | "saved" | "error";
  error?: string;
};
/** One intent, immutable retry payload, synchronous exclusion and stale-response fencing. */
export function createSettingsSubmission(
  send: (body: FormData) => Promise<SaveReply>,
  notify: (state: SaveState, reply?: SaveReply) => void,
  timeoutMs = 30000,
) {
  let locked = false,
    disposed = false,
    uncertain = false,
    sequence = 0;
  let frozen: FormData | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function run() {
    uncertain = false;
    const attempt = ++sequence;
    clearTimeout(timer);
    notify({ phase: "saving" });
    timer = setTimeout(() => {
      if (!disposed && attempt === sequence) {
        uncertain = true;
        notify({ phase: "unknown" });
      }
    }, timeoutMs);
    const body = new FormData();
    frozen!.forEach((v, k) => body.append(k, v));
    void send(body)
      .then((reply) => {
        if (disposed || attempt !== sequence) return;
        clearTimeout(timer);
        if (
          reply.operationId !== frozen!.get("operationId") ||
          typeof reply.ok !== "boolean"
        ) {
          uncertain = true;
          notify({ phase: "unknown" });
          return;
        }
        locked = false;
        notify(
          { phase: reply.ok ? "saved" : "error", error: reply.error },
          reply,
        );
      })
      .catch(() => {
        if (disposed || attempt !== sequence) return;
        clearTimeout(timer);
        // A rejected request/abort is not proof that the server rolled back.
        uncertain = true;
        notify({ phase: "unknown" });
      });
  }
  return {
    submit(body: FormData) {
      if (locked || disposed) return false;
      locked = true;
      frozen = new FormData();
      body.forEach((v, k) => frozen!.append(k, v));
      run();
      return true;
    },
    reconcile() {
      if (locked && uncertain && !disposed) run();
    },
    dispose() {
      disposed = true;
      sequence++;
      clearTimeout(timer);
    },
  };
}
