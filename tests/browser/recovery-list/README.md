# ARCH-019-SHOPIFY-003 local browser evidence

Start from the task implementation repository, with the normal workspace Node environment:

```sh
./node_modules/.bin/vite --config tests/browser/recovery-list/vite.config.ts
```

Open `http://127.0.0.1:4179/app/recoveries`. This fixture renders the **production
RecoveryList component, CSS and locale catalogues** in a React Router data router.
Its loader uses synthetic rows and a short deterministic delay to exercise UI
states. It makes no Shopify, database, provider or live-service calls. It is not
registered in production routes, and proves no deployed or embedded authentication
behaviour; the required unit suite independently tests the real route loader.

On 2026-09-20 the Codex in-app Chromium browser exercised:

- 320×900 viewport: stacked date/search/status controls, readable recovery rows,
  currency values, long email wrapping, RTL customer name and keyboard pagination.
  Observed `innerWidth=320`, `clientWidth=scrollWidth=305` (15px vertical scrollbar).
- 390×900 viewport with `?locale=de`: longer German labels fit without horizontal
  scrolling (`innerWidth=390`, `clientWidth=scrollWidth=375`).
- 1024×900 viewport: five-column filter grid, one recovery per horizontal row,
  `innerWidth=clientWidth=scrollWidth=1024`.
- Search: entered Ada and pressed Enter; URL retained embed/date fields and q=Ada;
  only Ada remained. Loading state announced Loading recoveries and disabled Apply.
- Next and Previous: activated native links using Enter; next page showed Guest,
  Detected and Unavailable value; previous returned the original two rows.
- Status: selected Ongoing in the native select and submitted Apply with Enter;
  only Engaged/Detected rows remained; cursor reset. A native arrow-key attempt
  did not change selection in the automation bridge; native select-option selection
  and keyboard form submission were verified separately.
- Dates: activated Today with Enter while filtering ongoing; saw filtered-empty
  guidance and Clear filters. Entered custom 19 September dates and submitted via
  Enter; the range and sole matching recovery updated together.
- Error/retry: `?fixture=error` showed a section-specific alert; keyboard activation
  of its Refresh button recovered the normal rows without losing context.
- `?fixture=never` showed No recoveries yet and the no-history explanation, distinct
  from filtered-empty. Invalid/date/cursor states also have unit-render evidence.
- Focus outline was visible on keyboard-activated date links. No modal, row click
  handler, mutation control, premature detail link or top-level navigation was added.

Screenshots in `evidence/` are actual viewport captures (not mockups):
`320.png`, `320-rows.png`, `390.png`, `1024.png`, and `error.png`.
The browser viewport override was reset after validation.

The server briefly restarted when its config was formatted; a fresh tab restored
the fixture. No browser security warning or network policy was bypassed. Full-page
capture temporarily changed viewport geometry, so final breakpoint evidence uses
verified viewport dimensions and viewport-only captures.

Additional fixture states: `?fixture=empty`, `?fixture=invalid`; error recovers on
manual Refresh. No polling. Fixture cursors are deliberately synthetic; actual
strict cursor binding and SQL keyset behavior are validated in the reader and route
unit suites, not by this UI-only fixture.
