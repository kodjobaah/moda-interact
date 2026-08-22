export default function Dashboard({ settings }) {
  return (
    <s-page heading="Moda Interact">
      <Stats />
      <RecentRecoveries />
      <RecoveryChart />
    </s-page>
  );
}