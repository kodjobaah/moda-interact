import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { Section } from "./state";

/** Shared, independently paginated read-only section; preserves focus after refresh. */
export function useRecoverySection<T>(initial: Section<T>, initialUrl: string) {
  const fetcher = useFetcher<Section<T>>();
  const [url, setUrl] = useState(initialUrl);
  const heading = useRef<HTMLHeadingElement>(null);
  const requested = useRef(false);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!busy && requested.current) {
      heading.current?.focus();
      requested.current = false;
    }
  }, [busy]);

  return {
    result: fetcher.data ?? initial,
    busy,
    heading,
    load: (next = url, focusHeading = true) => {
      requested.current = focusHeading;
      setUrl(next);
      fetcher.load(next);
    },
  };
}
