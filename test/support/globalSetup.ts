import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const serverDirectory = fileURLToPath(new URL("../server", import.meta.url));
const startTimeoutMs = 180_000;
const stopTimeoutMs = 10_000;

let server: ChildProcess | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`The test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`The test server did not answer ${url} in time`);
}

/**
 * Starts the Phoenix + Absinthe test server (test/server) once for the run.
 * The server stops when its stdin closes, so it cannot outlive this process.
 */
export async function setup(project: TestProject): Promise<void> {
  const port = await freePort();
  const child = spawn("mix", ["run", "--no-halt"], {
    cwd: serverDirectory,
    env: { ...process.env, PORT: String(port) },
    stdio: ["pipe", "ignore", "inherit"],
  });
  server = child;
  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(`${url}/health`, child);
  project.provide("serverUrl", url);
}

export async function teardown(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.stdin?.end();
  const timeout = new Promise((resolve) => {
    setTimeout(resolve, stopTimeoutMs);
  });
  await Promise.race([exited, timeout]);
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- exitCode changes when the child exits during the race above; the type narrowing before the await cannot see that.
  if (child.exitCode === null && child.pid !== undefined) child.kill();
}

declare module "vitest" {
  export interface ProvidedContext {
    serverUrl: string;
  }
}
