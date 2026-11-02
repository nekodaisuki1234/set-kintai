"use strict";
const fs = require("node:fs");
const REPOSITORY = "nekodaisuki1234/set-kintai", OWNER_ID = "79440835", REPOSITORY_ID = "1414011126";
function validateIdentity(claims) {
  const subjects = [
    `repo:${REPOSITORY}:ref:refs/heads/main`,
    `repo:nekodaisuki1234@${OWNER_ID}/set-kintai@${REPOSITORY_ID}:ref:refs/heads/main`
  ];
  if (!claims || claims.iss !== "https://token.actions.githubusercontent.com" || claims.aud !== "sts.amazonaws.com" ||
      claims.repository !== REPOSITORY || String(claims.repository_id) !== REPOSITORY_ID ||
      String(claims.repository_owner_id) !== OWNER_ID || claims.ref !== "refs/heads/main" ||
      !subjects.includes(claims.sub)) throw Error("Unexpected OIDC identity; do not create an AWS trust policy from it.");
  return { subject: claims.sub, audience: claims.aud, repository: claims.repository,
    repositoryId: claims.repository_id, ownerId: claims.repository_owner_id, ref: claims.ref };
}
async function main() {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== "refs/heads/main") {
    throw Error("OIDC setup is only available from this repository's main branch.");
  }
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) throw Error("Unexpected OIDC endpoint.");
  url.searchParams.set("audience", "sts.amazonaws.com");
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!bearer) throw Error("GitHub OIDC permission is missing.");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw Error("GitHub did not issue an OIDC token.");
  const body = await response.json();
  // Inspect only for setup; AWS independently verifies the signed token when assuming the role.
  const parts = typeof body.value === "string" ? body.value.split(".") : [];
  if (parts.length !== 3) throw Error("Invalid OIDC response.");
  const identity = validateIdentity(JSON.parse(Buffer.from(parts[1], "base64url").toString()));
  console.log(JSON.stringify(identity, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### AWS OIDC bootstrap identity\n\nCopy **subject** into the CloudShell bootstrap command. This is an identifier, not a credential.\n\n```json\n" + JSON.stringify(identity, null, 2) + "\n```\n");
}
module.exports = { validateIdentity };
if (require.main === module) main().catch(() => { console.error("OIDC identity check failed. No token or response body was logged; check workflow permissions and main-branch context."); process.exitCode = 1; });
