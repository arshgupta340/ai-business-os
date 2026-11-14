// npm run locations: lists sandbox locations so you can copy SQUARE_LOCATION_ID.
import { requireSquareEnv } from "./env.js";
import { makeClient, run } from "./common.js";

const env = requireSquareEnv(["SQUARE_ACCESS_TOKEN"]);
const client = makeClient(env.SQUARE_ACCESS_TOKEN);

await run("ListLocations", async () => {
  const res = await client.locations.list();
  const locations = res.locations ?? [];
  if (locations.length === 0) {
    console.log("No locations returned. A sandbox account normally has one default location.");
    return;
  }
  console.log(`SANDBOX: ${locations.length} location(s)\n`);
  for (const l of locations) {
    console.log(`  id=${l.id}  name=${l.name ?? ""}  status=${l.status ?? ""}  currency=${l.currency ?? ""}  country=${l.country ?? ""}`);
  }
  console.log("\nCopy the id of an ACTIVE location into SQUARE_LOCATION_ID in .env.local.");
});
