import {Breakpoint, IDebugger, MIError, Stack, Thread, DebuggerVariable} from "./debugger";
import * as ChildProcess from "child_process";
import {EventEmitter} from "events";
import {MINode, parseMI} from './parser.mi2';
import * as path from "path";
import * as fs from "fs";
import {SourceMap} from "./parser.c";
import {parseExpression, cleanRawValue} from "./functions";

const nonOutput = /(^(?:\d*|undefined)[*+\-=~@&^])([^*+\-=~@&]{1,})/;
const gdbRegex = /(?:\d*|undefined)\(gdb\)/;
const numRegex = /\d+/;
const gcovRegex = /"([0-9a-z_\-/\s\\:]+\.o)"/gi;

export function escape(str: string) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function couldBeOutput(line: string) {
  return !nonOutput.exec(line);
}

export class MI2 extends EventEmitter implements IDebugger {
  private map: SourceMap;
  private gcovFiles: Set<string> = new Set<string>();
  public procEnv: NodeJS.ProcessEnv;
  private currentToken = 1;
  private handlers: { [index: number]: (_: MINode) => unknown } = {};
  private breakpoints: Map<Breakpoint, number> = new Map();
  private buffer: string;
  private errbuf: string;
  private process: ChildProcess.ChildProcess;
  private lastStepCommand: () => Thenable<boolean>;
  private hasCobGetFieldStringFunction = true;
  private hasCobPutFieldStringFunction = true;

  constructor(
    public gdbpath: string,
    public gdbArgs: string[],
    public cobcpath: string,
    public cobcArgs: string[],
    procEnv: NodeJS.ProcessEnv,
    public verbose: boolean,
    public noDebug: boolean | null)
  {
    super();
    if (procEnv) {
      const env = {};
      // Duplicate process.env so we don't override it
      for (const key in process.env)
        if (key in process.env) {
          env[key] = process.env[key];
        }
        // Overwrite with user specified variables
        for (const key in procEnv) {
          if (key in procEnv) {
            if (procEnv === null) {
              delete env[key];
            } else {
              env[key] = procEnv[key];
            }
          }
        }
        this.procEnv = env;
    }
  }

  load(cwd: string, target: string, targetargs: string, group: string[]): Thenable<unknown> {
    group.map(e => { path.join(cwd, e); });

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(cwd)) {
        reject(new Error("cwd does not exist."));
      }

      if (this.noDebug) {
        const args = (this.cobcArgs || [])
        .concat([target])
        .concat(group)
        .concat(['-job=' + targetargs]);
        this.process = ChildProcess.spawn(this.cobcpath, args, {cwd: cwd, env: this.procEnv});
        this.process.stderr.on("data", ((data: string) => {
          this.log("stderr", data);
        }));
        this.process.stdout.on("data", ((data: string) => {
          this.log("stdout", data);
        }));
        this.process.on("exit", (() => {
          this.emit("quit");
        }));
        return;
      }

      const args = (this.cobcArgs || []).concat([
        '-g',                //enable debugger
        '-fsource-location', //generate source location code
        '-ftraceall',        // generate trace code
        '-Q',                // (with `--coverage`): enable C linker coverage
        '--coverage',
        '-A',                // (with `--coverage`): enable C compiler coverage
        '--coverage',
        '-v',                // verbose mode
        target
      ]).concat(group);
      const buildProcess = ChildProcess.spawn(this.cobcpath, args, {cwd: cwd, env: this.procEnv});
      buildProcess.stderr.on('data', (data: string) => {
        if (this.verbose)
          this.log("stderr", data);
        let match: RegExpExecArray;
        do {
          match = gcovRegex.exec(data);
          if (match) {
            this.gcovFiles.add(match[1].split('.').slice(0, -1).join('.'));
          }
        } while (match);
      });
      buildProcess.on('exit', (code) => {
        if (code !== 0) {
          this.emit("quit");
          return;
        }

        if (this.verbose) {
          this.log("stderr", `COBOL file ${target} compiled with exit code: ${code}`);
        }

        try {
          this.map = new SourceMap(cwd, [target].concat(group));
        } catch (e) {
          this.log('stderr', (<Error>e).toString());
        }

        if (this.verbose) {
          this.log("stderr", this.map.toString());
        }

        target = path.resolve(cwd, path.basename(target));
        target = target.split('.').slice(0, -1).join('.');
        // FIXME: the following should prefix "cobcrun.exe" if in "module mode", see #13
        // FIXME: if we need this code twice then add a comment why, otherwise move to a new
        //          function
        if (process.platform === "win32") {
          target = target + '.exe';
        }

        this.process = ChildProcess.spawn(
          this.gdbpath,
          this.gdbArgs,
          { cwd: cwd,
            env: this.procEnv });
        this.process.stdout.on("data", (data: string) => this.stdout(data));
        this.process.stderr.on("data", (data: string) => { this.log("stderr", data); });
        this.process.on("exit", () => { this.emit("quit"); });
        this.process.on("error", (err) => { this.emit("launcherror", err); });
        const promises = this.initCommands(target, targetargs, cwd);
        Promise.all(promises).then(() => {
          this.emit("debug-ready");
          resolve(undefined);
        }, reject);
      });
    });
  }

  attach(cwd: string, target: string, targetargs: string, group: string[]): Thenable<unknown> {
    if (!path.isAbsolute(target)) {
      target = path.join(cwd, target);
    }
    group.map(e => { path.join(cwd, e) });

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(cwd)) {
        reject(new Error("cwd does not exist."));
      }

      const args = (this.cobcArgs || []).concat([
        '-g',
        '-fsource-location',
        '-ftraceall',
        '-v',
        target
      ]).concat(group);
      const buildProcess = ChildProcess.spawn(this.cobcpath, args, {cwd: cwd, env: this.procEnv});
      buildProcess.stderr.on('data', (data: string) => {
        if (this.verbose)
          this.log("stderr", data);
      });
      buildProcess.on('exit', (code) => {
        if (code !== 0) {
          this.emit("quit");
          return;
        }

        if (this.verbose) {
          this.log("stderr", `COBOL file ${target} compiled with exit code: ${code}`);
        }

        try {
          this.map = new SourceMap(cwd, [target].concat(group));
        } catch (e) {
          this.log('stderr', (<Error>e).toString());
        }

        if (this.verbose) {
          this.log("stderr", this.map.toString());
        }

        target = path.resolve(cwd, path.basename(target));
        target = target.split('.').slice(0, -1).join('.');
        // FIXME: the following should prefix "cobcrun.exe" if in "module mode", see #13
        if (process.platform === "win32") {
          target = target + '.exe';
        }

        this.process = ChildProcess.spawn(
          this.gdbpath,
          this.gdbArgs,
          { cwd: cwd,
            env: this.procEnv });
        this.process.stdout.on("data", (data: string) => this.stdout(data));
        this.process.stderr.on("data", (data: string) => { this.log("stderr", data); });
        this.process.on("exit", () => { this.emit("quit"); });
        this.process.on("error", (err) => { this.emit("launcherror", err); });
        const promises = this.initCommands(target, targetargs, cwd);
        Promise.all(promises).then(() => {
          this.emit("debug-ready");
          resolve(undefined);
        }, reject);
      });
    });
  }

  protected initCommands(target: string, targetargs: string, cwd: string) {
    if (!path.isAbsolute(target)) {
      target = path.join(cwd, target);
    }
    if (process.platform === "win32") {
      cwd = path.dirname(target);
    }

    const cmds = [
      this.sendCommand("gdb-set target-async on", false),
      this.sendCommand("gdb-set print repeats 1000", false),
      this.sendCommand("gdb-set args " + targetargs, false),
      this.sendCommand("environment-directory \"" + escape(cwd) + "\"", false),
      this.sendCommand("file-exec-and-symbols \"" + escape(target) + "\"", false),
    ];
    return cmds;
  }

  stdout(data: string) {
    if (this.verbose) {
      this.log("stderr", "stdout: " + data);
    }
    this.buffer += data;
    const end = this.buffer.lastIndexOf('\n');
    if (end != -1) {
      this.onOutput(this.buffer.substring(0, end));
      this.buffer = this.buffer.substring(end + 1);
    }
    if (this.buffer.length) {
      if (this.onOutputPartial(this.buffer)) {
        this.buffer = "";
      }
    }
  }

  stderr(data: string) {
    if (this.verbose) {
      this.log("stderr", "stderr: " + data);
    }
    this.errbuf += data;
    const end = this.errbuf.lastIndexOf('\n');
    if (end != -1) {
      this.onOutputStderr(this.errbuf.substring(0, end));
      this.errbuf = this.errbuf.substring(end + 1);
    }
    if (this.errbuf.length) {
      this.logNoNewLine("stderr", this.errbuf);
      this.errbuf = "";
    }
  }

  stdin(data: string, cb?: (_err: Error) => void) {
    if (this.isReady()) {
      if (this.verbose) {
        this.log("stderr", "stdin: " + data);
      }
      this.process.stdin.write(data + "\n", cb);
    }
  }

  onOutputStderr(lines: string) {
    const linesArr = lines.split('\n');
    linesArr.forEach(line => {
      this.log("stderr", line);
    });
  }

  onOutputPartial(line: string) {
    if (couldBeOutput(line)) {
      this.logNoNewLine("stdout", line);
      return true;
    }
    return false;
  }

  onOutput(linesStr: string) {
    const lines = linesStr.split('\n');
    lines.forEach(line => {
      if (couldBeOutput(line)) {
        if (!gdbRegex.exec(line)) {
          this.log("stdout", line);
        }
      } else {
        const parsed = parseMI(line);
        if (this.verbose) {
          this.log("stderr", "GDB -> App: " + JSON.stringify(parsed));
        }
        let handled = false;
        if (parsed.token !== undefined) {
          if (this.handlers[parsed.token]) {
            this.handlers[parsed.token](parsed);
            delete this.handlers[parsed.token];
            handled = true;
          }
        }
        if (!handled && parsed.resultRecords && parsed.resultRecords.resultClass == "error") {
          this.log("stderr", <string>parsed.result("msg") || line);
        }
        if (parsed.outOfBandRecord) {
          parsed.outOfBandRecord.forEach(record => {
            if (record.isStream) {
              this.log(record.type, record.content);
            } else {
              if (record.type == "exec") {
                this.emit("exec-async-output", parsed);
                if (record.asyncClass == "running") {
                  this.emit("running", parsed);
                } else if (record.asyncClass == "stopped") {
                  const reason = <string>parsed.record("reason");
                  if (this.verbose) {
                    this.log("stderr", "stop: " + reason);
                  }
                  if (reason == "breakpoint-hit") {
                    this.emit("breakpoint", parsed);
                  } else if (reason == "end-stepping-range") {
                    if (!this.map.hasLineCobol(
                      <string>parsed.record('frame.fullname'),
                      parseInt(<string>parsed.record('frame.line'))))
                    {
                      void this.lastStepCommand().then();
                    } else {
                      this.emit("step-end", parsed);
                    }
                  } else if (reason == "function-finished") {
                    if (!this.map.hasLineCobol(
                      <string>parsed.record('frame.fullname'),
                      parseInt(<string>parsed.record('frame.line'))))
                    {
                      void this.lastStepCommand();
                    } else {
                      this.emit("step-out-end", parsed);
                    }
                  } else if (reason == "signal-received") {
                    this.emit("signal-stop", parsed);
                  } else if (reason == "exited-normally") {
                    this.emit("exited-normally", parsed);
                  } else if (reason == "exited") { // exit with error code != 0
                    if (this.verbose) {
                      this.log("stderr", "Program exited with code "
                               + <string>parsed.record("exit-code"));
                    }
                    this.emit("quit", parsed);
                  } else {
                    if (!this.map.hasLineCobol(
                      <string>parsed.record('frame.fullname'),
                      parseInt(<string>parsed.record('frame.line'))))
                    {
                      void this.continue();
                    } else {
                      if (this.verbose) {
                        this.log(
                          "stderr",
                          "Not implemented stop reason (assuming exception): " + reason);
                      }
                      this.emit("stopped", parsed);
                    }
                  }
                } else {
                  if (this.verbose) {
                    this.log("stderr", JSON.stringify(parsed));
                  }
                }
              } else if (record.type == "notify") {
                if (record.asyncClass == "thread-created") {
                  this.emit("thread-created", parsed);
                } else if (record.asyncClass == "thread-exited") {
                  this.emit("thread-exited", parsed);
                }
              }
            }
          });
          handled = true;
        }
        if (parsed.token == undefined
            && parsed.resultRecords == undefined
            && parsed.outOfBandRecord.length == 0)
        {
          handled = true;
        }
        if (!handled) {
          if (this.verbose) {
            this.log("stderr", "Unhandled: " + JSON.stringify(parsed));
          }
        }
      }
    });
  }

  start(attachTarget?: string): Thenable<boolean> {
    return new Promise((resolve, reject) => {
      if (this.noDebug) {
        return;
      }
      this.once("ui-break-done", () => {
        let command = "exec-run";
        let expectingResultClass = "running";
        if (attachTarget) {
          if (/^d+$/.test(attachTarget)) {
            command = `target-attach ${attachTarget}`;
            expectingResultClass = "done";
          } else {
            command = `target-select remote ${attachTarget}`;
            expectingResultClass = "connected";
          }
        }

        this.sendCommand(command).then((info) => {
          if (info.resultRecords.resultClass == expectingResultClass) {
            resolve(true);
          } else {
            reject();
          }
        }, reject);
      });
    });
  }

  stop() {
    const proc = this.process;
    if (proc) {
      const to = setTimeout(() => {
        process.kill(-proc.pid);
      }, 1000);
      this.process.on("exit", function (_code) {
        clearTimeout(to);
      });
    }
    void this.sendCommand("gdb-exit");
  }

  detach() {
    const proc = this.process;
    if (proc) {
      const to = setTimeout(() => {
        process.kill(-proc.pid);
      }, 1000);
      this.process.on("exit", function (_code) {
        clearTimeout(to);
      });
    }
    void this.sendCommand("target-detach");
  }

  interrupt(): Thenable<boolean> {
    if (this.verbose) {
      this.log("stderr", "interrupt");
    }
    return new Promise((resolve, reject) => {
      this.sendCommand("exec-interrupt").then((info) => {
        resolve(info.resultRecords.resultClass == "done");
      }, reject);
    });
  }

  continue(): Thenable<boolean> {
    if (this.verbose) {
      this.log("stderr", "continue");
    }
    return new Promise((resolve, reject) => {
      this.sendCommand("exec-continue").then((info) => {
        resolve(info.resultRecords.resultClass == "running");
      }, reject);
    });
  }

  /**
    * The command executes the line, then pauses at the next line.
    * The underlying function executes entirely.
    * FIXME: Implement execution graph instead of exec-next fallback
  */
  stepOver(): Thenable<boolean> {
    this.lastStepCommand = () => this.stepOver();
    if (this.verbose) {
      this.log("stderr", "stepOver");
    }
    return new Promise((resolve, reject) => {
      this.sendCommand("exec-next").then((info) => {
        resolve(info.resultRecords.resultClass == "running");
      }, reject);
    });
  }

  /**
    * The command executes the line, then pauses at the next line.
    * The command goes into the underlying function, then pauses at the first line.
    */
  stepInto(): Thenable<boolean> {
    this.lastStepCommand = () => this.stepInto() ;
    if (this.verbose) {
      this.log("stderr", "stepInto");
    }
    return new Promise((resolve, reject) => {
      this.sendCommand("exec-step").then((info) => {
        resolve(info.resultRecords.resultClass == "running");
      }, reject);
    });
  }

  /**
    * The comand executes the function, then pauses at the next line outside.
    */
  stepOut(): Thenable<boolean> {
    this.lastStepCommand = () => this.stepOut() ;
    if (this.verbose) {
      this.log("stderr", "stepOut");
    }
    return new Promise((resolve, reject) => {
      this.sendCommand("exec-finish").then((info) => {
        resolve(info.resultRecords.resultClass == "running");
      }, reject);
    });
  }

  goto(filename: string, line: number): Thenable<boolean> {
    if (this.verbose) {
      this.log("stderr", "goto");
    }
    return new Promise((resolve, reject) => {
      const target: string = '"' + (filename ? escape(filename) + ":" : "") + line.toString() + '"';
      this.sendCommand("break-insert -t " + target).then(() => {
        this.sendCommand("exec-jump " + target).then((info) => {
          resolve(info.resultRecords.resultClass == "running");
        }, reject);
      }, reject);
    });
  }

  async changeVariable(name: string, rawValue: string): Promise<void> {
    if (this.verbose) {
      this.log("stderr", "changeVariable");
    }

    const functionName = await this.getCurrentFunctionName();

    const cleanedRawValue = cleanRawValue(rawValue);

    try {
      const variable = this.map.getVariableByCobol(`${functionName}.${name.toUpperCase()}`);

      if (variable.attribute.type === "integer") {
        await this.sendCommand(`gdb-set var ${variable.cName}=${cleanedRawValue}`);
      } else if (this.hasCobPutFieldStringFunction && variable.cName.startsWith("f_")) {
        await this.sendCommand(
          `data-evaluate-expression
          "(int)cob_put_field_str(&${variable.cName}, \\"${cleanedRawValue}\\")"`);
      } else {
        const finalValue = variable.formatValue(cleanedRawValue);
        let cName = variable.cName;
        if (variable.cName.startsWith("f_")) {
          cName += ".data";
        }
        await
        this.sendCommand(`data-evaluate-expression
                         "(void)memcpy(${cName}, \\"${finalValue}\\", ${variable.size})"`);
      }
    } catch (e) {
      if ((<Error>e).message.includes("No symbol \"cob_put_field_str\"")) {
        this.hasCobPutFieldStringFunction = false;
        return this.changeVariable(name, rawValue);
      }
      this.log("stderr", `Failed to set cob field value on ${functionName}.${name}`);
      this.log("stderr", (<Error>e).message);
      throw e;
    }
  }

  loadBreakPoints(breakpoints: Breakpoint[]): Thenable<[boolean, Breakpoint][]> {
    if (this.verbose) {
      this.log("stderr", "loadBreakPoints");
    }
    const promisses = [];
    breakpoints.forEach(breakpoint => {
      promisses.push(this.addBreakPoint(breakpoint));
    });
    return Promise.all(promisses);
  }

  setBreakPointCondition(bkptNum: number, condition: string): Thenable<any> {
    if (this.verbose) {
      this.log("stderr", "setBreakPointCondition");
    }
    return this.sendCommand("break-condition " + bkptNum.toString() + " " + condition);
  }

  addBreakPoint(breakpoint: Breakpoint): Thenable<[boolean, Breakpoint]> {
    if (this.verbose) {
      this.log("stderr", "addBreakPoint ");
    }

    return new Promise((resolve, reject) => {
      if (this.breakpoints.has(breakpoint)) {
        return resolve([false, undefined]);
      }
      let location = "";
      if (breakpoint.countCondition) {
        if (breakpoint.countCondition[0] == ">") {
          location += "-i " + numRegex.exec(breakpoint.countCondition.substring(1))[0] + " ";
        } else {
          const match = numRegex.exec(breakpoint.countCondition)[0];
          if (match.length != breakpoint.countCondition.length) {
            this.log(
              "stderr",
              "Unsupported break count expression: '"
                + breakpoint.countCondition
                + "'. Only supports 'X' for breaking once after X times or '>X' for ignoring the "
                + "first X breaks");
            location += "-t ";
          } else if (parseInt(match) != 0) {
            location += "-t -i " + parseInt(match).toString() + " ";
          }
        }
      }

      const map = this.map.getLineC(breakpoint.file, breakpoint.line);
      if (map.fileC === '' && map.lineC === 0) {
        return;
      }

      if (breakpoint.raw) {
        location += '"' + escape(breakpoint.raw) + '"';
      } else {
        location += '"' + escape(map.fileC) + ":" + map.lineC.toString() + '"';
      }

      this.sendCommand("break-insert -f " + location).then((result) => {
        if (result.resultRecords.resultClass == "done") {
          const bkptNum = parseInt(<string>result.result("bkpt.number"));
          const bkptlocation = (<string>result.result("bkpt.original-location")).split(':');
          const map = this.map.getLineCobol(bkptlocation[0], parseInt(bkptlocation[1]));
          const newBrk = {
            file: map.fileCobol,
            line: map.lineCobol,
            condition: breakpoint.condition
          };
          if (breakpoint.condition) {
            this.setBreakPointCondition(bkptNum, breakpoint.condition)
            .then((result: MINode) => {
              if (result.resultRecords.resultClass == "done") {
                this.breakpoints.set(newBrk, bkptNum);
                resolve([true, newBrk]);
              } else {
                resolve([false, undefined]);
              }
            }, reject);
          } else {
            this.breakpoints.set(newBrk, bkptNum);
            resolve([true, newBrk]);
          }
        } else {
          reject(result);
        }
      }, reject);
    });
  }

  removeBreakPoint(breakpoint: Breakpoint): Thenable<boolean> {
    if (this.verbose) {
      this.log("stderr", "removeBreakPoint");
    }
    return new Promise((resolve, _reject) => {
      if (!this.breakpoints.has(breakpoint)) {
        return resolve(false);
      }
      this.sendCommand("break-delete " + this.breakpoints.get(breakpoint).toString())
      .then(
        (result: MINode) => {
          if (result.resultRecords.resultClass == "done") {
            this.breakpoints.delete(breakpoint);
            resolve(true);
          } else resolve(false);
        },
        (err: Error) => console.log(err));
    });
  }

  clearBreakPoints(): Thenable<unknown> {
    if (this.verbose) {
      this.log("stderr", "clearBreakPoints");
    }
    return new Promise((resolve, _reject) => {
      this.sendCommand("break-delete").then((result) => {
        if (result.resultRecords.resultClass == "done") {
          this.breakpoints.clear();
          resolve(true);
        } else resolve(false);
      }, () => {
        resolve(false);
      });
    });
  }

  async getThreads(): Promise<Thread[]> {
    if (this.verbose) {
      this.log("stderr", "getThreads");
    }
    return new Promise((resolve, reject) => {
      if (this.noDebug) {
        return;
      }
      this.sendCommand("thread-info").then((result) => {
        resolve((<Thread[]>result.result("threads")).map(element => {
          const ret: Thread = {
            id: parseInt(<string>MINode.valueOf(element, "id")),
            targetId: <string>MINode.valueOf(element, "target-id")
          };
          const name = <string>MINode.valueOf(element, "name");
          if (name) {
            ret.name = name;
          }
          return ret;
        }));
      }, reject);
    });
  }

  async getStack(maxLevels: number, thread: number): Promise<Stack[]> {
    if (this.verbose) {
      this.log("stderr", "getStack");
    }
    let command = "stack-list-frames";
    if (thread != 0) {
      command += ` --thread ${thread}`;
    }
    if (maxLevels) {
      command += " 0 " + maxLevels.toString();
    }
    const result = await this.sendCommand(command);
    const stack = <Stack[]>result.result("stack");
    return stack.map(element => {
      const level = MINode.valueOf(element, "@frame.level");
      const addr = MINode.valueOf(element, "@frame.addr");
      const func = MINode.valueOf(element, "@frame.func");
      const filename = MINode.valueOf(element, "@frame.file");
      let file: string = MINode.valueOf(element, "@frame.fullname");
      if (file) {
        file = path.normalize(file);
      }
      const from = parseInt(MINode.valueOf(element, "@frame.from"));

      let line = 0;
      const lnstr = MINode.valueOf(element, "@frame.line");
      if (lnstr) {
        line = parseInt(lnstr);
      }

      const map = this.map.getLineCobol(file, line);
      return {
        address: addr,
        fileName: path.basename(map.fileCobol),
        file: map.fileCobol,
        function: func || from,
        level: level,
        line: map.lineCobol
      };
    });
  }

  async getCurrentFunctionName(): Promise<string> {
    if (this.verbose) {
      this.log("stderr", "getCurrentFunctionName");
    }
    const response = await this.sendCommand("stack-info-frame");
    return response.result("frame.func").toLowerCase();
  }

  async getStackVariables(thread: number, frame: number): Promise<DebuggerVariable[]> {
    if (this.verbose) {
      this.log("stderr", "getStackVariables");
    }

    const functionName = await this.getCurrentFunctionName();

    const variablesResponse = await this.sendCommand(`stack-list-variables --thread ${thread} --frame ${frame} --all-values`);
    const variables = variablesResponse.result("variables");

    const currentFrameVariables = new Set<DebuggerVariable>();
    for (const element of variables) {
      const key = MINode.valueOf(element, "name");
      const value = MINode.valueOf(element, "value");

      if (key.startsWith("b_")) {
        const cobolVariable = this.map.getVariableByC(`${functionName}.${key}`);

        if (cobolVariable) {
          try {
            cobolVariable.setValue(value);
          } catch (e) {
            this.log("stderr", `Failed to set value on ${functionName}.${key}`);
            this.log("stderr", e.message);
            throw e;
          }
          currentFrameVariables.add(cobolVariable);
        }
      }
    }
    return Array.from(currentFrameVariables);
  }

  examineMemory(from: number, length: number): Thenable<any> {
    if (this.verbose) {
      this.log("stderr", "examineMemory");
    }
    return new Promise((resolve, reject) => {
      this.sendCommand("data-read-memory-bytes 0x" + from.toString(16) + " " + length).then((result) => {
        resolve(result.result("memory[0].contents"));
      }, reject);
    });
  }

  async evalExpression(expression: string, thread: number, frame: number): Promise<string> {
    const functionName = await this.getCurrentFunctionName();

    if (this.verbose) {
      this.log("stderr", "evalExpression");
    }

    let [finalExpression, variableNames] = parseExpression(expression, functionName, this.map);

    for (const variableName of variableNames) {
      const variable = this.map.getVariableByC(`${functionName}.${variableName}`);
      if (variable) {
        await this.evalVariable(variable, thread, frame);
        const value = variable.value;
        finalExpression = `const ${variableName}=${value};` + finalExpression;
      }
    }

    try {
      const result = `${eval(finalExpression)}`;
      if (/[^0-9.\-+]/g.test(result)) {
        return `"${result}"`;
      }
      return result;
    } catch (e) {
      this.log("stderr", e.message);
      return `Failed to evaluate ${expression}`;
    }
  }

  async evalCobField(name: string, thread: number, frame: number): Promise<DebuggerVariable> {
    const functionName = await this.getCurrentFunctionName();

    if (this.verbose) {
      this.log("stderr", "evalCobField");
    }

    try {
      const variable = this.map.getVariableByCobol(`${functionName}.${name.toUpperCase()}`);
      return await this.evalVariable(variable, thread, frame);
    } catch (e) {
      this.log("stderr", `Failed to eval cob field value on ${functionName}.${name}`);
      this.log("stderr", e.message);
      throw e;
    }
  }

  private async evalVariable(variable: DebuggerVariable, thread: number, frame: number): Promise<DebuggerVariable> {
    if (this.verbose) {
      this.log("stderr", "evalVariable");
    }

    let command = "data-evaluate-expression ";
    if (thread != 0) {
      command += `--thread ${thread} --frame ${frame} `;
    }

    if (this.hasCobGetFieldStringFunction && variable.cName.startsWith("f_")) {
      command += `"(char *)cob_get_field_str_buffered(&${variable.cName})"`;
    } else if (variable.cName.startsWith("f_")) {
      command += `${variable.cName}.data`;
    } else {
      command += variable.cName;
    }

    let dataResponse;
    let value = null;
    try {
      dataResponse = await this.sendCommand(command);
      value = dataResponse.result("value");
      if (value === "0x0") {
        value = null;
      }
    } catch (error) {
      if (error.message.includes("No symbol \"cob_get_field_str_buffered\"")) {
        this.hasCobGetFieldStringFunction = false;
        return this.evalVariable(variable, thread, frame);
      }
      this.log("stderr", error.message);
    }

    if (this.hasCobGetFieldStringFunction) {
      variable.setValueUsage(value);
    } else {
      variable.setValue(value);
    }

    return variable;
  }

  private logNoNewLine(type: string, msg: string): void {
    this.emit("msg", type, msg);
  }

  private log(type: string, msg: string): void {
    this.emit("msg", type, msg[msg.length - 1] == '\n' ? msg : (msg + "\n"));
  }

  sendUserInput(command: string, threadId: number = 0, frameLevel: number = 0): Thenable<any> {
    return new Promise((resolve, reject) => {
      this.stdin(command, resolve);
    });
  }

  private sendCommand(command: string, suppressFailure: boolean = false): Thenable<MINode> {
    return new Promise((resolve, reject) => {
      const sel = this.currentToken++;
      this.handlers[sel] = (node: MINode) => {
        if (node && node.resultRecords && node.resultRecords.resultClass === "error") {
          if (suppressFailure) {
            this.log("stderr", `WARNING: Error executing command '${command}'`);
            resolve(node);
          } else
            reject(new MIError(node.result("msg") || "Internal error", command));
        } else
          resolve(node);
      };
      this.stdin(sel + "-" + command);
    });
  }

  isReady(): boolean {
    return !!this.process;
  }

  getGcovFiles(): string[] {
    return Array.from(this.gcovFiles);
  }

  getSourceMap(): SourceMap {
    return this.map;
  }
}
