import * as vscode from 'vscode';

type InspectResult<T> = {
  key: string;
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  defaultLanguageValue?: T;
  globalLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
  languageIds?: string[];
} | undefined

export class DebuggerSettings {
    private readonly extensionSettings: vscode.WorkspaceConfiguration;
    private readonly superbolExtensionSettings: vscode.WorkspaceConfiguration;

    constructor() {
        this.extensionSettings = vscode.workspace.getConfiguration("superbol-vscode-debug");
        this.superbolExtensionSettings = vscode.workspace.getConfiguration("superbol");

console.log(this.getWithFallback<string>(this.superbolExtensionSettings, "path"));

    }

    private getWithFallback<T>(settings: vscode.WorkspaceConfiguration, section: string): T {
        const info: InspectResult<T> = settings.inspect<T>(section);
        if (info.workspaceFolderValue !== undefined) {
            return info.workspaceFolderValue;
        } else if (info.workspaceValue !== undefined) {
            return info.workspaceValue;
        } else if (info.globalValue !== undefined) {
            return info.globalValue;
        }
        return info.defaultValue;
    }

    public get displayVariableAttributes(): boolean {
        return this.getWithFallback<boolean>(this.extensionSettings, "displayVariableAttributes");
    }

    public get gdbpath(): string {
        return this.getWithFallback<string>(this.extensionSettings, "pathToGDB");
    }

    public get cobcpath(): string {
        return this.getWithFallback<string>(this.extensionSettings, "pathToCobc");
    }

    public get libcobpath(): string {
        return this.getWithFallback<string>(this.extensionSettings, "pathToLibCob");
    }
}
