// Checks the build output: no repo-only alias leaks into it, both formats
// load in Node without reading window, and the root exports the public API.
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const distDirectory = new URL("../dist/", import.meta.url).pathname;
const problems = [];

/**
 * @param {string} directory the directory to walk
 * @returns {Promise<string[]>} the paths of every file under it
 */
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat();
}

for (const path of await files(distDirectory)) {
  const code = await readFile(path, "utf8");
  if (code.includes("@apollo/client-3"))
    problems.push(`${path} imports the @apollo/client-3 alias`);
}

const rootApi = [
  "createAbsintheTransport",
  "getAbsintheTransport",
  "disposeAbsintheTransport",
  "onAbsintheTransport",
  "createPhoenixSocket",
  "AbsintheSocketError",
  "isAbsintheSocketError",
  "createAbsintheLink",
  "splitSubscriptions",
  "resyncOnJoin",
  "isSubscription",
];

// The package must not read window at import time (phoenix itself may).
Object.defineProperty(globalThis, "window", {
  configurable: true,
  get() {
    const stack = new Error().stack ?? "";
    // Line 0 is "Error", line 1 this getter, line 2 the code that read window.
    const reader = stack.split("\n")[2] ?? "";
    if (reader.includes("/dist/"))
      problems.push(`window was read at import time: ${reader.trim()}`);
    return undefined;
  },
});

/** @type {unknown} */
const esm = await import(new URL("../dist/index.mjs", import.meta.url).href);
/** @type {unknown} */
const cjs = require(join(distDirectory, "index.js"));
/** @type {[string, unknown][]} */
const builds = [
  ["esm", esm],
  ["cjs", cjs],
];
for (const [format, module] of builds)
  for (const name of rootApi)
    if (
      typeof module !== "object" ||
      module === null ||
      typeof Reflect.get(module, name) !== "function"
    )
      problems.push(`${format} root entry does not export ${name}`);

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("dist is fine");
