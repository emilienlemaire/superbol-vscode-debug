import * as vscode from "vscode";
import {GDBDebugSession} from "./gdb";
import {CoverageStatus} from './coverage';
import {DebuggerSettings} from "./settings";


export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('gdb', new GdbConfigurationProvider()),
        vscode.debug.
          registerDebugAdapterDescriptorFactory(
            'gdb',
            new GdbAdapterDescriptorFactory(new CoverageStatus(), new GDBDebugSession())));
}

class GdbConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
      _folder: vscode.WorkspaceFolder | undefined,
      config: vscode.DebugConfiguration,
      _token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration>
    {
        const settings = new DebuggerSettings();
        if (config.name === undefined) {
            config.name = "SuperBOL: default debug";
        }
        if (config.type === undefined) {
            config.type = "gdb";
        }
        if (config.request === undefined) {
            config.request = "launch";
        }
        if (config.target === undefined) {
            config.target = "${file}";
        }
        if (config.arguments === undefined) {
            config.arguments = "";
        }
        if (config.cwd === undefined) {
            config.cwd = "${workspaceRoot}";
        }
        if (config.group === undefined) {
            config.group = [];
        }
        if (config.gdbpath === undefined) {
            config.gdbpath = settings.gdbpath;
        }
        if (config.libcobpath === undefined) {
            config.libcobpath = settings.libcobpath;
        }
        if (config.env === undefined) {
            config.env = { ["LD_LIBRARY_PATH"] : config.libcobpath };
        } else {
            config.env.LD_LIBRARY_PATH = config.libcobpath + ";" + config.env.LD_LIBRARY_PATH;
        }
        if (config.coverage === undefined) {
            config.coverage = true;
        }
        config.gdbargs = ["-q", "--interpreter=mi2"];
        return config;
    }

    provideDebugConfigurations(
      _folder: vscode.WorkspaceFolder,
      _token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration[]> {
        const launchConfigDefault: vscode.DebugConfiguration = {
          name: "SuperBOL: debug launch",
          type: "gdb",
          request: "launch",
          target: "${file}",
          arguments: "",
          cwd: "${workspaceRoot}",
          group: [],
          coverage: true,
          verbose: false
        };

        const attachLocalConfiguration: vscode.DebugConfiguration = {
          name: "SuperBOL: debug attach local",
          type: "gdb",
          request: "attach",
          pid: "${input:pid}",
          target: "${file}",
          arguments: "",
          cwd: "${workspaceRoot}",
          group: [],
          verbose: false
        };

        const attachRemoteConfiguration: vscode.DebugConfiguration = {
          name: "SuperBOL: debug attach remote",
          type: "gdb",
          request: "attach",
          remoteDebugger: "${input:remoteDebugger}",
          target: "${file}",
          arguments: "",
          cwd: "${workspaceRoot}",
          group: [],
          verbose: false
        }

        return [
          launchConfigDefault,
          attachLocalConfiguration,
          attachRemoteConfiguration
        ];
    }
}

class GdbAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(public coverageBar: CoverageStatus, public debugSession: GDBDebugSession) {
    }

    createDebugAdapterDescriptor(_session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        this.debugSession.coverageStatus = this.coverageBar;
        return new vscode.DebugAdapterInlineImplementation(this.debugSession);
    }
}
