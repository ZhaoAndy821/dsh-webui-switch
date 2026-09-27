# Deliver a console control event to another process, the way Ctrl+C does in a
# terminal. DSH's own graceful path is a console Ctrl+C, so this reproduces it
# for a process this plugin did not spawn in its own console.
#
# Ctrl+C cannot be aimed at one process - Microsoft: "this signal cannot be
# limited to a specific process group" - so the event reaches every process that
# shares the console. This helper therefore refuses to generate it when the
# console holds anyone besides the target and this helper: the caller escalates
# to a targeted tree kill instead of signalling bystanders.
#
# usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#          -File send-console-ctrl.ps1 -ProcessId <pid> [-CtrlEvent 0] [-DryRun]
#
# exit codes: 0 delivered, 1 GenerateConsoleCtrlEvent refused,
#             2 the target has no console this process may attach to,
#             3 the helper could not compile its interop shim,
#             4 the console is shared with other processes - refused, nothing sent.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [int]$CtrlEvent = 0,
  [switch]$DryRun
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

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList(uint[] processList, uint count);
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

# Who else is on this console? The list holds this helper and normally the target;
# anything beyond those two would receive the event as well, so refuse instead.
$buffer = New-Object 'uint32[]' 64
$count = [DshConsoleCtrl]::GetConsoleProcessList($buffer, 64)

# Fail closed. A console that really holds this helper and the target answers 2 at
# minimum; 0 or 1 means the enumeration failed or the target is not on the console
# this helper reached, and a larger answer than the buffer means the list was
# truncated. In every one of those cases the members cannot be judged, and an
# unjudged console is exactly the one that must not be signalled.
if ($count -lt 2 -or $count -gt 64) {
  [DshConsoleCtrl]::FreeConsole() | Out-Null
  exit 4
}

$others = @()
for ($i = 0; $i -lt $count; $i++) {
  $member = [int]$buffer[$i]
  if ($member -ne $PID -and $member -ne $ProcessId) { $others += $member }
}

if ($others.Count -gt 0) {
  [DshConsoleCtrl]::FreeConsole() | Out-Null
  exit 4
}

if ($DryRun) {
  [DshConsoleCtrl]::FreeConsole() | Out-Null
  exit 0
}

# Ignore the event in this helper so it is not the one that reacts.
[DshConsoleCtrl]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null

$delivered = [DshConsoleCtrl]::GenerateConsoleCtrlEvent([uint32]$CtrlEvent, 0)
$lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()

Start-Sleep -Milliseconds 200
[DshConsoleCtrl]::FreeConsole() | Out-Null

if ($delivered) { exit 0 }
if ($lastError -ne 0) { exit 1 }
exit 1
