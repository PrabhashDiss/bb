import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderBridgeLaunch } from "./testing/parity.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FAIL_STDOUT_HANDLE = `
import { constants } from "node:os";
function failStdoutHandleWrites(failures) {
  const handle = process.stdout._handle;
  let remaining = failures;
  for (const method of ["writev", "writeUtf8String", "writeBuffer", "writeLatin1String"]) {
    const original = handle[method];
    if (typeof original !== "function") continue;
    handle[method] = (...args) => {
      if (remaining > 0) {
        remaining -= 1;
        return -constants.errno.ENOBUFS;
      }
      return original.apply(handle, args);
    };
  }
}
`;

interface BridgeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBridge(
  source: string,
  input: string,
  endInputAfterStdout?: string,
): Promise<BridgeRun> {
  const dir = mkdtempSync(join(tmpdir(), "bb-bridge-stdout-"));
  tempDirs.push(dir);
  const modulePath = join(dir, "bridge.mjs");
  writeFileSync(modulePath, source);
  const launch = resolveProviderBridgeLaunch({
    modulePath,
    pluginId: "stdout-fixture",
    dataDir: join(dir, "data"),
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (
      endInputAfterStdout !== undefined &&
      stdout.includes(endInputAfterStdout)
    ) {
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(input);
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("bridge worker entry stdout guards", () => {
  it("survives synchronous ENOBUFS on its stdout pipe and delivers every line", async () => {
    const run = await runBridge(
      `${FAIL_STDOUT_HANDLE}
export const experimental_providerBridge = {
  experimental_apiVersion: 1,
  handleLine(line) {
    if (line !== "burst") return;
    failStdoutHandleWrites(4);
    for (let index = 0; index < 500; index += 1) {
      process.stdout.write(JSON.stringify({ index }) + "\\n");
    }
    process.stdout.write("done\\n");
  },
  onClose() {
    process.exit(0);
  },
};
`,
      "burst\n",
      "done\n",
    );
    expect(run.stderr).not.toContain("Unhandled 'error' event");
    expect(run.code).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines.at(-1)).toBe("done");
    expect(lines.slice(0, -1)).toEqual(
      Array.from({ length: 500 }, (_, index) => JSON.stringify({ index })),
    );
  }, 30_000);

  it("shuts down through onClose instead of throwing when stdout fails for good", async () => {
    const run = await runBridge(
      `
export const experimental_providerBridge = {
  experimental_apiVersion: 1,
  handleLine(line) {
    if (line !== "fail") return;
    process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  },
  onClose() {
    process.stderr.write("onClose\\n");
    process.exit(0);
  },
};
`,
      "fail\n",
    );
    expect(run.stderr).not.toContain("Unhandled 'error' event");
    expect(run.stderr).toContain(
      "Provider bridge stdout failed (EPIPE); shutting down: write EPIPE",
    );
    expect(run.stderr.match(/onClose/g)).toEqual(["onClose"]);
    expect(run.code).toBe(0);
  }, 30_000);

  it("exits non-zero when a bridge without onClose loses stdout", async () => {
    const run = await runBridge(
      `
export const experimental_providerBridge = {
  experimental_apiVersion: 1,
  handleLine(line) {
    if (line !== "fail") return;
    process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  },
};
`,
      "fail\n",
    );
    expect(run.stderr).not.toContain("Unhandled 'error' event");
    expect(run.stderr).toContain("Provider bridge stdout failed (EPIPE)");
    expect(run.code).toBe(1);
  }, 30_000);
});
