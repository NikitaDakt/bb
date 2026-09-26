import type { EnrollmentBootstrap } from "./enrollments.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function manualEnrollmentCommand(
  bootstrap: EnrollmentBootstrap,
  shell: "posix" | "powershell" = "posix",
): string {
  if (shell === "powershell") {
    const installerUrl = new URL("/install.ps1", bootstrap.serverUrl).href;
    return `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -Headers @{'X-BB-Enrollment'=${quotePowerShell(bootstrap.credential)}} -Uri ${quotePowerShell(installerUrl)}).Content))`;
  }
  const header = `X-BB-Enrollment: ${bootstrap.credential}`;
  const installerUrl = new URL("/install.sh", bootstrap.serverUrl).href;
  return `curl -sSL --fail-with-body -H ${quote(header)} ${quote(installerUrl)} | sh`;
}

export function enrolledInstallerScript(
  script: string,
  bootstrap: EnrollmentBootstrap,
  shell: "posix" | "powershell" = "posix",
): string {
  if (shell === "powershell") {
    return `$env:BB_ENROLLMENT=${quotePowerShell(JSON.stringify(bootstrap))}\ntry { & {\n${script}\n} -BootstrapEnv BB_ENROLLMENT } finally { Remove-Item Env:BB_ENROLLMENT -ErrorAction SilentlyContinue }\n`;
  }
  return `export BB_ENROLLMENT=${quote(JSON.stringify(bootstrap))}\nset -- --bootstrap-env BB_ENROLLMENT\n${script}`;
}
