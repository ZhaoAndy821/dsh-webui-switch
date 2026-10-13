<#
.SYNOPSIS
  Report the job object the calling process is in, as one JSON line.

.DESCRIPTION
  A process can query its own job with a NULL job handle, which is the only way to
  read limits this plugin cannot otherwise see: the Web profile is spawned without
  CREATE_BREAKAWAY_FROM_JOB, so it inherits the Desktop Host's job.

  Why it matters (measured 2026-10-13/14): the profile died twice with exit code
  0xC0000409 - the fail-fast code - leaving no dump and no log. A job carrying
  JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION turns an unhandled exception into
  exactly that: immediate termination, no WER, no dump.

  SCOPE, measured by review on 2026-10-14: NULL returns the INNERMOST job only.
  Windows 8+ nests jobs, and limits from every job in the chain apply, so a
  dieOnUnhandledException:false here does NOT disprove the hypothesis - it only says
  the innermost job does not carry the flag. An outer job is invisible from inside a
  process; naming the chain would need a handle this plugin does not have.

  On failure it prints {"inJob":false,"lastError":<win32>} - so "not in a job" and
  "in a job that could not be read" are distinguishable by the error code rather
  than silently merged.
#>
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class JobInfo {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT {
    public BASIC Basic; public IO_COUNTERS Io;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, ref EXT info, int len, out int ret);
}
'@

$info = New-Object JobInfo+EXT
$returned = 0
$ok = [JobInfo]::QueryInformationJobObject([IntPtr]::Zero, 9, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), [ref]$returned)
if (-not $ok) {
    $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    ('{"inJob":false,"lastError":' + $last + '}')
    exit 0
}
$flags = $info.Basic.LimitFlags
function MB([UIntPtr]$v) { [math]::Round([double]$v.ToUInt64() / 1MB, 1) }
$payload = [ordered]@{
    inJob                    = $true
    limitFlags               = ('0x{0:X}' -f $flags)
    dieOnUnhandledException  = (($flags -band 0x400) -ne 0)
    killOnJobClose           = (($flags -band 0x2000) -ne 0)
    processMemoryLimitMB     = (MB $info.ProcessMemoryLimit)
    jobMemoryLimitMB         = (MB $info.JobMemoryLimit)
    activeProcessLimit       = $info.Basic.ActiveProcessLimit
    peakJobMemoryUsedMB      = (MB $info.PeakJobMemoryUsed)
    peakProcessMemoryUsedMB  = (MB $info.PeakProcessMemoryUsed)
}
$payload | ConvertTo-Json -Compress
