export default function Onboarding() {
  return (
    <s-page heading="Welcome to Moda Interact">
      <s-section>
        <s-heading>
          Recover more abandoned checkouts
        </s-heading>

        <s-paragraph>
          Moda Interact helps you reconnect with customers who leave before
          completing their purchase.
        </s-paragraph>
      </s-section>

      <s-section>
        <s-heading>
          Get started
        </s-heading>

        <s-paragraph>
          Choose the plan that works best for your store to start using
          Moda Interact.
        </s-paragraph>

        <s-button href="/app/billing">
          Choose a plan
        </s-button>
      </s-section>
    </s-page>
  );
}