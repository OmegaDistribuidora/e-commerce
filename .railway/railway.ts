import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "e-commerce";
export default defineRailway(() => {
  const eCommerce = service("e-commerce", {
    source: github("OmegaDistribuidora/e-commerce", { branch: "main", checkSuites: false }),
    // O Railpack detecta os scripts `build` e `start` do package.json.
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    replicas: { "us-east4-eqdc4a": 1 },
    domains: ["omegadistribuidora.com.br"],
  });

  return project("e-Commerce", {
    variables: { managed: false },
    resources: [eCommerce],
  });
});
