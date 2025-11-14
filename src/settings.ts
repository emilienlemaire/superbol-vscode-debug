import * as vscode from 'vscode';

export class DebuggerSettings {
    private readonly debugSettings: vscode.WorkspaceConfiguration;

    constructor() {
        this.debugSettings = vscode.workspace.getConfiguration("superbol.debugger");
        //this.globalSettings = vscode.workspace.getConfiguration("superbol");
    }

    public get displayVariableAttributes(): boolean {
        return this.debugSettings.get<boolean>("displayVariableAttributes");
    }

    public get gdbpath(): string {
        return this.debugSettings.get<string>("gdbPath");
    }

    public get libcobpath(): string {
        return this.debugSettings.get<string>("libcobPath");
    }

    public get gdbtty(): string {
        return this.debugSettings.get<string>("gdbtty");
    }

    public get cobcrunPath(): string {
        return this.debugSettings.get<string>("cobcrunPath");
    }
}
