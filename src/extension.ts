import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as child_process from "child_process";

interface JestConfigMapEntry {
  pattern: string;
  config: string;
  cwd?: string;
}

interface JestDebugConfiguration extends vscode.DebugConfiguration {
  defaultJestConfigPath: string;
  defaultCwd: string;
  jestConfigMap?: JestConfigMapEntry[];
}

type RequiredConfigKeys = {
  type: "node";
  request: "launch";
  program: string;
  console: "integratedTerminal";
  internalConsoleOptions: "neverOpen";
  runtimeArgs: string[];
};

const REQUIRED_CONFIG_KEYS: RequiredConfigKeys = {
  type: "node",
  request: "launch",
  program: "${workspaceFolder}/node_modules/.bin/jest",
  console: "integratedTerminal",
  internalConsoleOptions: "neverOpen",
  runtimeArgs: ["--dns-result-order=ipv4first"],
} as const;

function checkNodeVersion(workspaceFolder: string): void {
  try {
    const nvmrcPath = path.join(workspaceFolder, ".nvmrc");
    if (!fs.existsSync(nvmrcPath)) return;

    const currentVersion = child_process
      .execSync("node --version", { encoding: "utf8" })
      .trim();
    const expectedVersion = fs.readFileSync(nvmrcPath, "utf8").trim();

    const normalizedCurrent = currentVersion.startsWith("v")
      ? currentVersion
      : `v${currentVersion}`;
    const normalizedExpected = expectedVersion.startsWith("v")
      ? expectedVersion
      : `v${expectedVersion}`;

    if (normalizedCurrent !== normalizedExpected) {
      vscode.window.showWarningMessage(
        `Node version mismatch: using ${normalizedCurrent}, but .nvmrc specifies ${normalizedExpected}`
      );
    }
  } catch (error) {
    console.error("Error checking Node version:", error);
  }
}

class JestDebugConfigProvider implements vscode.DebugConfigurationProvider {
  private static readonly logger = {
    error: (message: string, error?: unknown) => {
      console.error(message, error);
      vscode.window.showErrorMessage(message);
    },
    warn: (message: string) => {
      console.warn(message);
      vscode.window.showWarningMessage(message);
    },
  };

  private findMatchingConfig(
    configMap: JestConfigMapEntry[],
    filePath: string
  ): JestConfigMapEntry | undefined {
    for (const entry of configMap) {
      try {
        if (new RegExp(entry.pattern).test(filePath)) {
          return entry;
        }
      } catch (error) {
        JestDebugConfigProvider.logger.error(
          `Invalid regex pattern: ${entry.pattern}`,
          error
        );
      }
    }
    return undefined;
  }

  private validatePaths(
    defaultCwd: string,
    defaultJestConfig: string,
    jestPath: string
  ): boolean {
    if (!fs.existsSync(defaultCwd)) {
      JestDebugConfigProvider.logger.error(
        `Working directory not found: ${defaultCwd}`
      );
      return false;
    }

    if (!fs.existsSync(defaultJestConfig)) {
      JestDebugConfigProvider.logger.error(
        `Default Jest config not found: ${defaultJestConfig}`
      );
      return false;
    }

    if (!fs.existsSync(jestPath)) {
      JestDebugConfigProvider.logger.error(`Jest not found at: ${jestPath}`);
      return false;
    }

    return true;
  }

  private validateConfig(config: JestDebugConfiguration): boolean {
    if (!config.defaultJestConfigPath) {
      JestDebugConfigProvider.logger.error(
        "defaultJestConfigPath is required in launch configuration"
      );
      return false;
    }

    if (!config.defaultCwd) {
      JestDebugConfigProvider.logger.error(
        "defaultCwd is required in launch configuration"
      );
      return false;
    }

    if (config.jestConfigMap) {
      for (const entry of config.jestConfigMap) {
        if (!entry.pattern || !entry.config) {
          JestDebugConfigProvider.logger.error(
            "Each jestConfigMap entry must have both pattern and config properties"
          );
          return false;
        }
        try {
          new RegExp(entry.pattern);
        } catch (error) {
          JestDebugConfigProvider.logger.error(
            `Invalid regex pattern in jestConfigMap: ${entry.pattern}`,
            error
          );
          return false;
        }
      }
    }

    return true;
  }

  resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: JestDebugConfiguration,
    _token: vscode.CancellationToken
  ): vscode.DebugConfiguration | undefined {
    if (!this.validateConfig(config)) {
      return undefined;
    }

    if (!folder) {
      JestDebugConfigProvider.logger.error(
        "No workspace folder found. Please open a workspace."
      );
      return undefined;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      JestDebugConfigProvider.logger.error(
        "No active editor — cannot determine test file."
      );
      return undefined;
    }

    checkNodeVersion(folder.uri.fsPath);

    const filePath = editor.document.uri.fsPath;
    const defaultCwd =
      this.resolveWorkspacePath(config.defaultCwd, folder) ||
      path.join(folder.uri.fsPath, "src");
    const defaultJestConfig =
      this.resolveWorkspacePath(config.defaultJestConfigPath, folder) ||
      path.join(defaultCwd, "jest.config.js");
    const jestPath = path.join(folder.uri.fsPath, "node_modules/.bin/jest");

    if (!this.validatePaths(defaultCwd, defaultJestConfig, jestPath)) {
      return undefined;
    }

    const configMap: JestConfigMapEntry[] = config.jestConfigMap || [];
    let matchedEntry = this.findMatchingConfig(configMap, filePath) || {
      pattern: ".*",
      config: defaultJestConfig,
      cwd: defaultCwd,
    };

    const resolvedCwd = matchedEntry.cwd
      ? matchedEntry.cwd.replace("${workspaceFolder}", folder.uri.fsPath)
      : defaultCwd;

    const resolvedConfig = matchedEntry.config.replace(
      "${workspaceFolder}",
      folder.uri.fsPath
    );

    const requiredConfig = {
      ...REQUIRED_CONFIG_KEYS,
      args: [filePath, "--config", resolvedConfig],
      cwd: resolvedCwd,
      skipFiles: ["<node_internals>/**"],
      autoAttachChildProcesses: true,
      resolveSourceMapLocations: [
        "${workspaceFolder}/**",
        "!**/node_modules/**",
      ],
      env: {
        NODE_ENV: "test",
      },
    };

    Object.entries(REQUIRED_CONFIG_KEYS).forEach(([key, value]) => {
      if (config[key] && config[key] !== value) {
        vscode.window.showWarningMessage(
          `Overriding user setting "${key}": "${config[key]}" with required value: "${value}"`
        );
      }
    });

    const mergedConfig = {
      ...config,
      ...requiredConfig,
      env: {
        ...config.env,
        ...requiredConfig.env,
      },
      args: [...(config.args || []), ...requiredConfig.args],
    };

    return mergedConfig;
  }

  private resolveWorkspacePath(
    configPath: string | undefined,
    folder: vscode.WorkspaceFolder
  ): string | undefined {
    return configPath?.replace("${workspaceFolder}", folder.uri.fsPath);
  }
}

async function getJestConfig(): Promise<
  { folder: vscode.WorkspaceFolder; config: any } | undefined
> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor found");
    return;
  }

  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) {
    vscode.window.showErrorMessage("No workspace folder found");
    return;
  }

  // Get all launch configurations
  const launchConfigs = vscode.workspace.getConfiguration("launch", folder);
  const configs = launchConfigs.get<any[]>("configurations") || [];

  // Find all Jest debug configurations
  const jestConfigs = configs.filter(
    (config) =>
      config.type === "node" &&
      config.defaultJestConfigPath &&
      config.defaultCwd
  );

  if (jestConfigs.length === 0) {
    vscode.window.showErrorMessage(
      "No Jest debug configurations found in launch.json. Please add at least one with defaultJestConfigPath and defaultCwd."
    );
    return;
  }

  let selectedConfig: any;
  if (jestConfigs.length === 1) {
    selectedConfig = jestConfigs[0];
  } else {
    const selected = await vscode.window.showQuickPick(
      jestConfigs.map((config) => ({
        label: config.name,
        description: `Config: ${config.defaultJestConfigPath}`,
        detail: `Working Dir: ${config.defaultCwd}`,
        config,
      })),
      {
        placeHolder: "Select Jest Configuration",
        title: "Multiple Jest Configurations Found",
      }
    );
    if (!selected) {
      return; // User cancelled
    }
    selectedConfig = selected.config;
  }

  return { folder, config: selectedConfig };
}

async function runJestTests(folder: vscode.WorkspaceFolder, config: any) {
  const debugProvider = new JestDebugConfigProvider();
  const resolvedConfig = debugProvider.resolveDebugConfiguration(
    folder,
    config,
    new vscode.CancellationTokenSource().token
  );

  if (!resolvedConfig) {
    return;
  }

  // Get absolute path to Jest in the workspace root
  const jestPath = path.join(folder.uri.fsPath, "node_modules", ".bin", "jest");

  const terminal = vscode.window.createTerminal("Jest Tests");
  terminal.sendText(
    `cd ${
      resolvedConfig.cwd
    } && NODE_ENV=test node --dns-result-order=ipv4first ${jestPath} ${resolvedConfig.args.join(
      " "
    )}`
  );
  terminal.show();
}

async function startJestSession(debug: boolean = true) {
  const result = await getJestConfig();
  if (!result) {
    return;
  }

  const { folder, config } = result;

  if (debug) {
    await vscode.debug.startDebugging(folder, config);
  } else {
    await runJestTests(folder, config);
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "node",
      new JestDebugConfigProvider()
    ),
    vscode.commands.registerCommand("jest-debug.debug", () =>
      startJestSession(true)
    ),
    vscode.commands.registerCommand("jest-debug.run", () =>
      startJestSession(false)
    )
  );
}

export function deactivate() {}
