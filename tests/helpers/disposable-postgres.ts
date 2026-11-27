import {
  createDockerRunner,
  EphemeralPostgres,
  type DockerRunner,
  type EphemeralPostgresOptions,
} from "@modainteract/moda-interact-shared/testing/node";

export type DisposablePostgres = {
  databaseUrl: string;
  cleanup(): Promise<void>;
};

type PostgresCredentials = Pick<
  EphemeralPostgresOptions,
  "database" | "user" | "password"
>;

/** The caller owns its migrations, database clients and seed data. Never use
 * DATABASE_URL or TEST_DATABASE_URL to select the database for these fixtures. */
export async function startDisposablePostgres(
  credentials: PostgresCredentials = {},
  docker: DockerRunner = createDockerRunner(),
): Promise<DisposablePostgres> {
  let cleaned = false;
  const cleanupErrors: unknown[] = [];
  const postgres = new EphemeralPostgres({
    ...credentials,
    image: "pgvector/pgvector:pg17",
    host: "127.0.0.1",
    runDocker: async (args, options) => {
      let command = [...args];
      if (command[0] === "run") {
        // Shared owns the random container name and host port selection.
        // Restrict the published port to loopback for local test databases.
        const publish = command.indexOf("--publish");
        if (publish < 0 || command[publish + 1] !== "0:5432") {
          throw new Error("Unexpected Shared PostgreSQL port publication");
        }
        command[publish + 1] = "127.0.0.1::5432";
      } else if (command[0] === "exec" && command[2] === "pg_isready") {
        // The official image starts a temporary socket-only server while
        // initializing the database. Wait for the final TCP listener instead.
        command = [...command, "--host", "127.0.0.1"];
      }
      try {
        return await docker(command, options);
      } catch (error) {
        if (command[0] === "rm") cleanupErrors.push(error);
        throw error;
      }
    },
  });
  // Shared attempts cleanup if container creation or readiness fails and
  // preserves the startup error as its cause.
  const { databaseUrl } = await postgres.start();
  return {
    databaseUrl,
    async cleanup() {
      if (cleaned) return;
      cleanupErrors.length = 0;
      await postgres.cleanup();
      // Shared cleanup is best effort; surface a failed explicit teardown
      // rather than silently reporting success and leaving a container behind.
      if (cleanupErrors.length) throw cleanupErrors[0];
      cleaned = true;
    },
  };
}
