# Recovery detail local browser evidence

Run from the implementation worktree with the workspace Node environment:

```sh
./node_modules/.bin/vite --config tests/browser/recovery-detail/vite.config.ts
```

Open `http://127.0.0.1:4179/app/recoveries?from=2026-09-01&to=2026-09-20&status=all&q=Ada&pageSize=25&shop=fixture.myshopify.com`.

The fixture renders production list/detail components, CSS and locale catalogues in a React Router data router. It supplies synthetic data (125 messages, nine recovery rows) and a 350ms resource delay. No Shopify, Meta or database requests occur. Its simple numeric fixture cursors are not production cursors; actual authorization and cursor readers are covered by the route/reader unit suites. These screenshots do not certify deployed Shopify embedding.

Observed in Chromium on 2026-09-20:

- Keyboard Enter opens a list row directly. Related basket links retain `from/to/status/q/pageSize/shop`; Back returns to the same filtered list. A list scrolled to 900px restored to 900px after detail → Back. Detail reload preserved the return context and rendered the initial message window. A direct detail entry also rendered successfully.
- First transcript window contained 50 messages; Next started with message 51. Jump to latest showed messages 76–125 (50); Previous showed 26–75 (50). Resource loading disabled controls and showed a structural placeholder. On completion focus moved to the Conversation heading. The accepted production reader suite separately verifies keyset boundaries and ownership.
- Related recovery Next replaced the first five entries with the remaining bounded entries, enabled Previous, disabled Next and focused the Related recoveries heading. Related selection resets the transcript to the selected basket.
- `/app/recoveries/error`: first Conversation Refresh returned a section-local error; checkout header, milestones and related entries remained visible. The error Refresh restored messages. `/app/recoveries/empty` displayed No conversation recorded. `/app/recoveries/missing` displayed Recovery unavailable with Back.
- 1024px: two-column transcript/context. 320px: stacked summary and transcript, wrapped controls and long URL. 390px with `?locale=de`: German labels and localized money/date fit. Document scroll widths were 1009/305/375px respectively, below the explicit 1024/320/390px viewports. No nested transcript scrolling.
- RTL Arabic, escaped literal script text, all sender labels, successful/rejected audio transcription and unsupported content displayed safely. No audio playback, composer or provider metadata appeared.
- Native Checkout context disclosure toggled using Enter. Viewport overrides were reset and temporary tabs closed after validation.

Viewport screenshots: `evidence/1024.png`, `320.png`, `390.png`, `error.png`. The German screenshot captures the transcript after reload scroll restoration. All imagery contains synthetic fixture data only.

## Attempt 2 — equivalent URL scroll regression

The fixture now uses the production `recoveryScrollKey` callback. It saves the loader-normalized list identity. Detail Back carries that same validated identity in router navigation state, because React Router looks up destination scroll before destination loader data is available. Navigation state is used only to select a saved scroll position, never as a URL or authorization input.

Actual Chromium rerun: omitted defaults (`/app/recoveries`), reordered explicit filters, canonical filters, and a reordered synthetic cursor page each traversed list → basket 5 → related basket 2 → Back. Every scenario restored **575px → 575px**. The cursor case retained its original cursor. Results are in `evidence/attempt2-scroll.json`; `attempt2-restored.png` shows the resulting scrolled list. The fixture cursor is synthetic; valid production cursor binding is separately tested in the unit suite. Direct `/app/recoveries/basket-1` and reload both retained a local default Back link.

The initial data-only key attempt failed the actual browser replay because React Router uses previous loader data during the restoration lookup. The submitted correction covers that timing with a regression test. Attempt 1 screenshots and observations above remain historical evidence; its raw-search scroll identity was defective for omitted/reordered defaults, as documented in architect review.
