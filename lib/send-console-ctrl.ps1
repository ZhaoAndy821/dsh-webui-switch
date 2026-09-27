# Deliver a console control event to another process, the way Ctrl+C does in a
# terminal. DSH's own graceful path is a console Ctrl+C, so this reproduces it
# for a process this plugin did not spawn in its own console.
#
# usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#          -File send-console-ctrl.ps1 -ProcessId <pid> [-CtrlEvent 0]
#
# exit codes: 0 delivered, 1 GenerateConsoleCtrlEvent refused,
#             2 the target has no console this process may attach to,
#             3 the helper could not compile its interop shim.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [int]$CtrlEvent = 0
)

$ErrorActionPreference = 'Stop'

try {
  $interop = @'
using System;
using System.Runtime.InteropServices;

public static class DshConsoleCtrl
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
}
'@
  Add-Type -TypeDefinition $interop
} catch {
  exit 3
}

# Detach from our own inherited console first: AttachConsole fails while this
# process still holds one.
[DshConsoleCtrl]::FreeConsole() | Out-Null

if (-not [DshConsoleCtrl]::AttachConsole([uint32]$ProcessId)) {
  exit 2
}

# Ignore the event in this helper so only the target's console group reacts.
[DshConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null

$delivered = [DshConsoleCtrl]::GenerateConsoleCtrlEvent([uint32]$CtrlEvent, 0)
$lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()

Start-Sleep -Milliseconds 200
[DshConsoleCtrl]::FreeConsole() | Out-Null

if ($delivered) { exit 0 }
if ($lastError -ne 0) { exit 1 }
exit 1
