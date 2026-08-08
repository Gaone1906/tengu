export interface ServiceProgramSpec {
  label: string;
  execPath: string;
  args: string[];
  workingDirectory: string;
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

export type RunCommandResult = { stdout: string; stderr: string };
export type RunCommandFn = (
  file: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<RunCommandResult>;

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  raw?: string;
}
