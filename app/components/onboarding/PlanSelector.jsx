const plans = [
  {
    id: "starter",
    name: "Starter",
    price: "£19",
    description: "For smaller stores getting started with recovery.",
    features: [
      "Abandoned checkout recovery",
      "1 automated email reminder",
      "Basic analytics",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    price: "£49",
    description: "For growing stores that want more automation.",
    features: [
      "Multiple recovery reminders",
      "AI-generated messages",
      "Discount incentives",
      "Advanced analytics",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "£99",
    description: "For stores that want the full recovery suite.",
    features: [
      "Email and SMS recovery",
      "AI personalisation",
      "Advanced segmentation",
      "Priority support",
    ],
  },
];

export default function PlanSelector({
  selectedPlan,
  onSelect,
}) {
  return (
    <s-section heading="Choose your plan">
      <s-paragraph>
        Select the Moda Interact plan that best fits your store.
      </s-paragraph>

      <s-stack direction="block" gap="base">
        {plans.map((plan) => {
          const selected = selectedPlan === plan.id;

          return (
            <s-box
              key={plan.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="base">
                <s-heading>{plan.name}</s-heading>

                <s-paragraph>
                  <strong>{plan.price}</strong> / month
                </s-paragraph>

                <s-paragraph>
                  {plan.description}
                </s-paragraph>

                <s-unordered-list>
                  {plan.features.map((feature) => (
                    <s-list-item key={feature}>
                      {feature}
                    </s-list-item>
                  ))}
                </s-unordered-list>

                <s-button
                  variant={selected ? "primary" : "secondary"}
                  onClick={() => onSelect(plan.id)}
                >
                  {selected ? "Selected" : `Choose ${plan.name}`}
                </s-button>
              </s-stack>
            </s-box>
          );
        })}
      </s-stack>
    </s-section>
  );
}