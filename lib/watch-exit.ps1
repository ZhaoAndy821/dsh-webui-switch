# Report the exit code of a process this host did not create.
#
# Usage: powershell -NoProfile -File watch-exit.ps1 -ProcessId <pid>
# Prints exactly one line: "code=<n>", or "code=unavailable" when the process
# cannot be opened (already gone, or no rights) or its code cannot be read.
#
# Why P/Invoke: measured on this deployment (2026-10-10), neither
# Get-Process + WaitForExit + ExitCode nor [Diagnostics.Process]::GetProcessById
# can report the code of a process this script did not start - both return
# $null. A handle opened while the process is still alive and read with
# GetExitCodeProcess does return it, which is the whole point of adopting an
# inherited profile instead of only polling "is it still there".
#
# The parameter is named ProcessId, not Pid: PowerShell is case-insensitive and
# $PID is read-only, so a $Pid parameter cannot be assigned.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId
)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ExitWatch {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
}
'@

$SYNCHRONIZE = 0x00100000
$QUERY_LIMITED = 0x1000
$INFINITE = [uint32]::MaxValue
$STILL_ACTIVE = 259

$handle = [ExitWatch]::OpenProcess(($SYNCHRONIZE -bor $QUERY_LIMITED), $false, $ProcessId)
if ($handle -eq [IntPtr]::Zero) {
    'code=unavailable'
    exit 0
}
try {
    [ExitWatch]::WaitForSingleObject($handle, [uint32]$INFINITE) | Out-Null
    $code = [uint32]0
    if (-not [ExitWatch]::GetExitCodeProcess($handle, [ref]$code)) {
        'code=unavailable'
    } else {
        # Always the number: a caller must not have to read "still-active" as if the
        # handle had failed to open. 259 can only mean the process was still running
        # when the wait returned, which the wait itself should make impossible - it is
        # reported separately so the reader can tell "we read it" from "we could not".
        'code=' + $code
        if ($code -eq $STILL_ACTIVE) {
            'still=1'
        }
    }
} finally {
    [ExitWatch]::CloseHandle($handle) | Out-Null
}
