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
        config.gdbargs = ["-q", "--interpreter=mi2"];
        const settings = new DebuggerSettings();
        if (config.cwd === undefined) {
            config.cwd = settings.cwd;
        }
        if (config.target === undefined) {
            config.target = settings.target;
        }
        if (config.group === undefined) {
            config.group = [];
        }
        if (config.arguments === undefined) {
            config.arguments = "";
        }
        if (config.gdbpath === undefined) {
            config.gdbpath = settings.gdbpath;
        }
        if (config.cobcpath === undefined) {
            config.cobcpath = settings.cobcpath;
        }
        return config;
    }

    provideDebugConfigurations(
      _folder: vscode.WorkspaceFolder,
      _token?: vscode.CancellationToken):
        vscode.ProviderResult<vscode.DebugConfiguration[]> {
        const launchConfigDefault: vscode.DebugConfiguration = {
          name: "Superbol debugger",
          type: "gdb",
          request: "launch",
          cobcargs: [
            "-free",
            "-x"
          ],
          coverage: true
        };

        const attachLocalConfiguration: vscode.DebugConfiguration = {
          name: "Superbol debugger attach local",
          type: "gdb",
          request: "attach",
          cobcargs: [
            "-free",
            "-x"
          ],
          pid: "${input:pid}"
        };

        const attachRemoteConfiguration: vscode.DebugConfiguration = {
          name: "Superbol debugger attach remote",
          type: "gdb",
          request: "attach",
          cobcargs: [
            "-free",
            "-x"
          ],
          remoteDebugger: "${input:remoteDebugger}"
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
