// Prints the service account email, the address to share the calendar and sheet with.
// Then asks Google for a token, which proves the key is valid.

import { run } from "./cli.js";
import { authClient } from "./google.js";

run({}, async (cfg) => {
  const sa = cfg.serviceAccount;
  console.log(`Service account: ${sa.clientEmail}`);
  console.log(`Project:         ${sa.projectId ?? "(not in key)"}`);
  console.log(`Key source:      ${sa.source}`);
  console.log(`Env file:        ${cfg.envFile ?? "(none, using the process environment)"}`);
  const token = await authClient(sa).getAccessToken();
  if (!token.token) throw new Error("Google returned no access token.");
  console.log("Key check:       Google issued an access token (not printed).");
  console.log(`\nShare the demo calendar and the demo sheet with ${sa.clientEmail}, with edit rights.`);
});
