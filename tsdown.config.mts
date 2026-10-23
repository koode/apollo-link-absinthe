import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "tsdown";

const apollo3Alias = "@apollo/client-3";
const apolloPackages = /^@apollo\/client(-3)?(\/|$)/;

/**
 * The repo installs Apollo 3 as `@apollo/client-3` next to Apollo 4, so each
 * entry type-checks against its own Apollo. The published files import
 * `@apollo/client`: the copy the app has installed.
 */
async function rewriteApollo3Alias(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteApollo3Alias(path);
      continue;
    }
    const code = await readFile(path, "utf8");
    const rewritten = code
      .replaceAll(`"${apollo3Alias}/`, '"@apollo/client/')
      .replaceAll(`"${apollo3Alias}"`, '"@apollo/client"');
    if (rewritten !== code) await writeFile(path, rewritten);
  }
}

export default defineConfig({
  entry: ["src/index.ts", "src/apollo3.ts"],
  format: ["esm", "cjs"],
  platform: "neutral",
  target: "es2020",
  unbundle: true,
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  deps: {
    neverBundle: [apolloPackages, "graphql", "phoenix"],
    onlyBundle: false,
    dts: { neverBundle: [apolloPackages, "graphql", "phoenix"] },
  },
  onSuccess: () => rewriteApollo3Alias("dist"),
});
