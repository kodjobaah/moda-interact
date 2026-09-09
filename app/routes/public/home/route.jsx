import {
  redirect,
  Form,
  useLoaderData,
} from "react-router";

import { login } from "../../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(
      `/app?${url.searchParams.toString()}`,
    );
  }

  return {
    showForm: Boolean(login),
  };
};

export default function PublicHome() {
  const { showForm } = useLoaderData();

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.brand}>
          <img
            className={styles.logo}
            src="/images/moda-interact-logo.jpg"
            alt=""
          />

          <span className={styles.brandName}>
            Moda Interact
          </span>
        </header>

        <section className={styles.hero}>
          <p className={styles.eyebrow}>
            Shopify checkout recovery
          </p>

          <h1 className={styles.heading}>
            Recover abandoned checkouts with
            intelligent customer conversations
          </h1>

          <p className={styles.description}>
            Moda Interact reconnects with customers
            who leave before completing their purchase,
            using personalised recovery conversations
            designed to bring them back to checkout.
          </p>
        </section>

        {showForm && (
          <section
            className={styles.connectCard}
            aria-labelledby="connect-heading"
          >
            <div className={styles.connectIntro}>
              <h2
                id="connect-heading"
                className={styles.connectHeading}
              >
                Connect your Shopify store
              </h2>

              <p className={styles.connectDescription}>
                Enter your permanent
                <strong> .myshopify.com </strong>
                domain to continue.
              </p>
            </div>

            <Form
              className={styles.form}
              method="post"
              action="/auth/login"
            >
              <div className={styles.field}>
                <label
                  className={styles.label}
                  htmlFor="shop-domain"
                >
                  Shop domain
                </label>

                <input
                  id="shop-domain"
                  className={styles.input}
                  type="text"
                  name="shop"
                  placeholder="your-store.myshopify.com"
                  autoComplete="off"
                  required
                />

                <span className={styles.helpText}>
                  Example: acme.myshopify.com
                </span>
              </div>

              <button
                className={styles.button}
                type="submit"
              >
                Connect your store
              </button>
            </Form>
          </section>
        )}

        <section
          className={styles.features}
          aria-label="Moda Interact features"
        >
          <article className={styles.feature}>
            <div className={styles.featureNumber}>
              01
            </div>

            <h2>Recover abandoned checkouts</h2>

            <p>
              Identify abandoned purchase journeys
              and automatically begin recovery at the
              right time.
            </p>
          </article>

          <article className={styles.feature}>
            <div className={styles.featureNumber}>
              02
            </div>

            <h2>Personalised follow-up</h2>

            <p>
              Continue the conversation through
              intelligent WhatsApp messaging tailored
              to the customer and checkout.
            </p>
          </article>

          <article className={styles.feature}>
            <div className={styles.featureNumber}>
              03
            </div>

            <h2>Measure recovered revenue</h2>

            <p>
              Track recoveries, conversations and the
              revenue Moda Interact helps return to
              your store.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}