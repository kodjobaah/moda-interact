import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
<div className={styles.index}>
  <div className={styles.content}>
    <h1 className={styles.heading}>
      Recover abandoned checkouts and turn lost sales into revenue
    </h1>

    <p className={styles.text}>
      Moda Interact helps Shopify stores automatically reconnect with customers
      who leave before completing their purchase using intelligent, personalised
      recovery campaigns.
    </p>

    {showForm && (
      <Form className={styles.form} method="post" action="/auth/login">
        <label className={styles.label}>
          <span>Shop domain</span>

          <input
            className={styles.input}
            type="text"
            name="shop"
            placeholder="your-store.myshopify.com"
          />

          <span>e.g. your-store.myshopify.com</span>
        </label>

        <button className={styles.button} type="submit">
          Connect your store
        </button>
      </Form>
    )}

    <ul className={styles.list}>
      <li>
        <strong>Recover abandoned checkouts.</strong>{" "}
        Automatically identify customers who leave checkout without completing
        their purchase and start a recovery journey.
      </li>

      <li>
        <strong>Personalised follow-up.</strong>{" "}
        Send automated recovery messages based on your chosen timing,
        communication channels, and customer behaviour.
      </li>

      <li>
        <strong>Track recovered revenue.</strong>{" "}
        See abandoned checkouts, successful recoveries, recovery rates, and the
        revenue Moda Interact has helped return to your store.
      </li>
    </ul>
  </div>
</div>
  );
}
