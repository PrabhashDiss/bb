import { spawn, type ChildProcess } from "node:child_process";
import { posix as posixPath } from "node:path";
import {
  hasProcessExited,
  waitForProcessExit,
  waitForProcessExitWithTimeout,
  type ChildProcessExitResult,
} from "@bb/config/child-process-exit";

interface RuntimeLogBuffer {
  append(chunk: Buffer | string): void;
  text(): string;
}

interface CreateRuntimeLogBufferArgs {
  maxLines: number;
}

interface StartBbAppProcessArgs {
  bridgePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logLineLimit: number;
  runtime: BbAppProcessRuntime;
}

export interface BbAppProcess {
  childProcess: ChildProcess;
  exit: Promise<BbAppProcessExit>;
  logs: RuntimeLogBuffer;
  pid: number;
  stop(args: StopBbAppProcessArgs): Promise<void>;
}

export type BbAppProcessExit = ChildProcessExitResult;

interface StopBbAppProcessArgs {
  killSignal: NodeJS.Signals;
  killTimeoutMs: number;
  signal: NodeJS.Signals;
  timeoutMs: number;
}

type BbAppProcessRuntimeMode = "electron-node" | "node";

interface DirectBbAppProcessRuntime {
  executablePath: string;
  kind: "direct";
  mode: BbAppProcessRuntimeMode;
}

interface AppImageBbAppProcessRuntime {
  appDirPath: string;
  executablePath: string;
  kind: "appimage";
  mode: "electron-node";
}

type BbAppProcessRuntime =
  | AppImageBbAppProcessRuntime
  | DirectBbAppProcessRuntime;

interface CreateBbAppProcessLaunchArgs {
  bridgePath: string;
  env: NodeJS.ProcessEnv;
  runtime: BbAppProcessRuntime;
}

interface BbAppProcessLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
}

interface CreateBbAppProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  runtimeMode: BbAppProcessRuntimeMode;
}

interface ResolveBbAppProcessRuntimeArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  processExecPath: string;
}

const APPIMAGE_BRIDGE_RELATIVE_PATH_ENV =
  "BB_DESKTOP_APPIMAGE_BRIDGE_RELATIVE_PATH";

export function createAppImageChildProcessEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const appDirPath = env.APPDIR?.trim().replace(/\/+$/u, "") ?? "";
  if (appDirPath.length === 0 || (env.APPIMAGE?.trim() ?? "").length === 0) {
    return env;
  }

  const separatorIndex = appDirPath.lastIndexOf("/");
  const mountParentPath = appDirPath.slice(0, separatorIndex);
  const isRuntimeMount = appDirPath
    .slice(separatorIndex + 1)
    .startsWith(".mount_");
  const isAppImageRoot = (rootPath: string): boolean => {
    if (rootPath === appDirPath) {
      return true;
    }
    if (!isRuntimeMount || !rootPath.startsWith(`${mountParentPath}/`)) {
      return false;
    }
    const mountName = rootPath.slice(mountParentPath.length + 1);
    return mountName.startsWith(".mount_") && !mountName.includes("/");
  };
  const injectedSuffixesByName: Record<string, string[]> = {
    GSETTINGS_SCHEMA_DIR: ["/usr/share/glib-2.0/schemas"],
    LD_LIBRARY_PATH: ["/usr/lib"],
    PATH: ["", "/usr/sbin"],
    XDG_DATA_DIRS: ["/usr/share/"],
  };

  const childEnv = { ...env };
  for (const [name, suffixes] of Object.entries(injectedSuffixesByName)) {
    const value = childEnv[name];
    if (value === undefined) {
      continue;
    }
    const entries: string[] = [];
    for (const entry of value.split(":")) {
      const isInjected = suffixes.some(
        (suffix) =>
          entry.endsWith(suffix) &&
          isAppImageRoot(entry.slice(0, entry.length - suffix.length)),
      );
      if (entry.length > 0 && !isInjected && !entries.includes(entry)) {
        entries.push(entry);
      }
    }
    if (entries.length === 0) {
      delete childEnv[name];
    } else {
      childEnv[name] = entries.join(":");
    }
  }
  return childEnv;
}

async function runAppImageBridgeSupervisor(
  bridgeRelativePathEnv: string,
  createChildProcessEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): Promise<void> {
  const { spawn: spawnChild } = process.getBuiltinModule("node:child_process");
  const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { resolve: resolvePath } = process.getBuiltinModule("node:path");
  const appDirPath = process.env.APPDIR;
  const bridgeRelativePath = process.env[bridgeRelativePathEnv];
  if (!appDirPath || !bridgeRelativePath) {
    throw new Error("AppImage bridge bootstrap environment is incomplete");
  }

  const bridgePath = resolvePath(appDirPath, bridgeRelativePath);
  const bridgeProcess = spawnChild(process.execPath, [bridgePath], {
    env: createChildProcessEnv(process.env),
    stdio: "inherit",
  });
  if (bridgeProcess.pid === undefined) {
    throw new Error("AppImage bridge process did not expose a PID");
  }

  const supervisorPid = process.pid;
  let terminationSignal: NodeJS.Signals | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const signalBridgeGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-supervisorPid, signal);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }
      throw error;
    }
  };
  const bridgeGroupHasLiveDescendants = (): boolean => {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
        continue;
      }
      const pid = Number(entry.name);
      if (pid === supervisorPid) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const state = fields[0];
        const processGroupId = Number(fields[2]);
        if (state !== "Z" && processGroupId === supervisorPid) {
          return true;
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          continue;
        }
        throw error;
      }
    }
    return false;
  };
  const beginTermination = (signal: NodeJS.Signals): void => {
    if (terminationSignal !== null) {
      return;
    }
    terminationSignal = signal;
    signalBridgeGroup(signal);
    killTimer = setTimeout(() => signalBridgeGroup("SIGKILL"), 4_000);
  };
  process.on("SIGINT", () => beginTermination("SIGINT"));
  process.on("SIGTERM", () => beginTermination("SIGTERM"));

  const bridgeExitCode = await new Promise<number | null>(
    (resolveExit, rejectExit) => {
      bridgeProcess.once("error", rejectExit);
      bridgeProcess.once("exit", (code) => resolveExit(code));
    },
  );
  while (bridgeGroupHasLiveDescendants()) {
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }
  if (killTimer !== null) {
    clearTimeout(killTimer);
  }
  if (terminationSignal === null) {
    process.exitCode = bridgeExitCode ?? 1;
  }
}

const APPIMAGE_BRIDGE_BOOTSTRAP = `await (${runAppImageBridgeSupervisor.toString()})(${JSON.stringify(APPIMAGE_BRIDGE_RELATIVE_PATH_ENV)}, ${createAppImageChildProcessEnv.toString()});`;

function createRuntimeLogBuffer(
  args: CreateRuntimeLogBufferArgs,
): RuntimeLogBuffer {
  const lines: string[] = [];

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const line of text.split(/\r?\n/u)) {
        if (line.length === 0) {
          continue;
        }
        lines.push(line);
      }
      while (lines.length > args.maxLines) {
        lines.shift();
      }
    },
    text() {
      return lines.join("\n");
    },
  };
}

export function createBbAppProcessEnv(
  args: CreateBbAppProcessEnvArgs,
): NodeJS.ProcessEnv {
  if (args.runtimeMode === "electron-node") {
    return { ...args.env, ELECTRON_RUN_AS_NODE: "1" };
  }

  const env = { ...args.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function resolveBbAppProcessRuntime(
  args: ResolveBbAppProcessRuntimeArgs,
): BbAppProcessRuntime {
  if (args.isPackaged) {
    const appImagePath = args.env.APPIMAGE?.trim();
    const appDirPath = args.env.APPDIR?.trim();
    if (
      args.platform === "linux" &&
      appImagePath !== undefined &&
      appImagePath.length > 0 &&
      appDirPath !== undefined &&
      appDirPath.length > 0
    ) {
      return {
        appDirPath,
        executablePath: appImagePath,
        kind: "appimage",
        mode: "electron-node",
      };
    }

    return {
      executablePath: args.processExecPath,
      kind: "direct",
      mode: "electron-node",
    };
  }

  const rawNodeExecPath = args.env.BB_DESKTOP_NODE_EXEC_PATH?.trim();
  if (rawNodeExecPath === undefined || rawNodeExecPath.length === 0) {
    throw new Error(
      "BB_DESKTOP_NODE_EXEC_PATH is required in desktop dev mode. Launch through apps/desktop/scripts/run-electron-dev.mjs.",
    );
  }

  return {
    executablePath: rawNodeExecPath,
    kind: "direct",
    mode: "node",
  };
}

export function createBbAppProcessLaunch(
  args: CreateBbAppProcessLaunchArgs,
): BbAppProcessLaunch {
  const env = createBbAppProcessEnv({
    env: args.env,
    runtimeMode: args.runtime.mode,
  });
  if (args.runtime.kind === "direct") {
    return {
      args: [args.bridgePath],
      env,
      executablePath: args.runtime.executablePath,
    };
  }

  const bridgeRelativePath = posixPath.relative(
    args.runtime.appDirPath,
    args.bridgePath,
  );
  if (
    bridgeRelativePath.length === 0 ||
    posixPath.isAbsolute(bridgeRelativePath) ||
    bridgeRelativePath === ".." ||
    bridgeRelativePath.startsWith("../")
  ) {
    throw new Error("bb-app bridge path must be inside the AppImage mount");
  }

  return {
    args: [
      "--input-type=module",
      "--eval",
      APPIMAGE_BRIDGE_BOOTSTRAP,
      "--",
      args.bridgePath,
      "--no-sandbox",
    ],
    env: {
      ...env,
      [APPIMAGE_BRIDGE_RELATIVE_PATH_ENV]: bridgeRelativePath,
    },
    executablePath: args.runtime.executablePath,
  };
}

export function startBbAppProcess(args: StartBbAppProcessArgs): BbAppProcess {
  const logs = createRuntimeLogBuffer({ maxLines: args.logLineLimit });
  const launch = createBbAppProcessLaunch({
    bridgePath: args.bridgePath,
    env: args.env,
    runtime: args.runtime,
  });
  const childProcess = spawn(launch.executablePath, launch.args, {
    cwd: args.cwd,
    detached: args.runtime.kind === "appimage",
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = childProcess.pid;
  if (pid === undefined) {
    throw new Error("bb-app child process did not expose a PID");
  }

  if (childProcess.stdout !== null) {
    childProcess.stdout.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  if (childProcess.stderr !== null) {
    childProcess.stderr.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  const exit = waitForProcessExit(childProcess);

  return {
    childProcess,
    exit,
    logs,
    pid,
    async stop(stopArgs) {
      if (hasProcessExited(childProcess)) {
        return;
      }
      childProcess.kill(stopArgs.signal);
      const gracefulResult = await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.timeoutMs,
      });
      if (gracefulResult === "exited") {
        return;
      }

      if (!hasProcessExited(childProcess)) {
        childProcess.kill(stopArgs.killSignal);
      }
      await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.killTimeoutMs,
      });
    },
  };
}
