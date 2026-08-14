import { main } from "./index.js";

// PM2 keeps an IPC channel open for managed processes. A failed startup must
// therefore terminate explicitly: assigning process.exitCode alone can leave
// an idle process that PM2 incorrectly reports as online.
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
