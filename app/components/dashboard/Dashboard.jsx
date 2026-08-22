import Stats from "@/components/dashboard/Stats";

export default function Dashboard({ settings, stats }) {
  return (
    <s-page heading="Moda Interact">
      <Stats {...stats} />
    </s-page>
  );
}