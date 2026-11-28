import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";

/** Render real links and data-router forms in a server context, not a client router. */
export async function renderStaticRoute(
  element: ReactElement,
  pathname = "/",
  routePath = pathname,
): Promise<string> {
  const handler = createStaticHandler([{ path: routePath, element }]);
  const context = await handler.query(
    new Request(new URL(pathname, "https://app.test")),
  );
  if (context instanceof Response) {
    throw new Error(`Unexpected static route response: ${context.status}`);
  }
  if (context.errors) {
    throw new Error("Static route fixture failed", { cause: context.errors });
  }
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToStaticMarkup(
    createElement(StaticRouterProvider, { router, context, hydrate: false }),
  );
}
