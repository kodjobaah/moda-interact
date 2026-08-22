import { useState } from "react";
import PlanSelector from "./PlanSelector";


export default function Onboarding() {
  const [selectedPlan, setSelectedPlan] = useState("growth");

  return (
    <s-page heading="Welcome to Moda Interact">
      <s-section>
        <s-heading>Recover more abandoned checkouts</s-heading>

        <s-paragraph>
          Moda Interact helps you reconnect with customers who leave before
          completing their purchase.
        </s-paragraph>
      </s-section>

      <PlanSelector
        selectedPlan={selectedPlan}
        onSelect={setSelectedPlan}
      />
    </s-page>
  );
}