import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Windows PowerShell provides .NET interop on the target Windows x64 hosts.
// Keep the handle in the gated Node launcher, not in TexLite or a permanent
// helper process. The handle is non-inheritable and dies with that launcher.
const native = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class TexLiteJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static void Attach(string name, IntPtr process) {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        int error = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new Win32Exception(error);
        try {
            if (error == 183) throw new Win32Exception(error); // ERROR_ALREADY_EXISTS
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
            IntPtr ownedHandle;
            if (!DuplicateHandle(GetCurrentProcess(), job, process, out ownedHandle, 0, false, 2)) throw new Win32Exception();
        } finally { CloseHandle(job); }
    }

    public static void Stop(string name) {
        IntPtr job = OpenJobObject(0x000C, false, name); // JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            // Once the last handle is closed, the kernel destroys the job
            // only after every member has terminated.
            if (error == 2) return; // ERROR_FILE_NOT_FOUND
            throw new Win32Exception(error);
        }
        try {
            if (Active(job) == 0) return;
            if (!TerminateJobObject(job, 1)) {
                int error = Marshal.GetLastWin32Error();
                if (Active(job) != 0) throw new Win32Exception(error);
                return;
            }
            Stopwatch timer = Stopwatch.StartNew();
            while (true) {
                if (Active(job) == 0) return;
                if (timer.ElapsedMilliseconds >= 3000) throw new TimeoutException("TexLite job still has active processes");
                Thread.Sleep(30);
            }
        } finally { CloseHandle(job); }
    }

    static uint Active(IntPtr job) {
        Accounting value;
        if (!QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
        return value.ActiveProcesses;
    }
}
`;

function jobName(executionId: string, kind: "Agent" | "Command"): string {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(executionId)) throw new Error("Invalid execution ID");
  // Use the same namespace across login sessions when the server restarts.
  return `Global\\TexLite.${kind}.${executionId}`;
}

async function powershell(body: string): Promise<void> {
  const command = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${native}\n'@\n${body}`;
  const executable = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    await run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string })?.stderr?.trim();
    throw new Error(stderr ? `Windows job: ${stderr.slice(0, 512)}` : "Could not manage the Windows job", { cause: error });
  }
}

/** Attach before issuing the launch permit, so all CLI descendants inherit the job. */
export async function attachWindowsJob(pid: number, executionId: string, kind: "Agent" | "Command"): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Windows launcher PID");
  const name = jobName(executionId, kind);
  await powershell(`
$launcher = Get-Process -Id ${pid} -ErrorAction Stop
try {
  $handle = $launcher.Handle
  $entry = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop
  if (-not $entry.CommandLine -or -not $entry.CommandLine.Contains('${executionId}') -or $launcher.HasExited) {
    throw 'The launcher identity changed before job assignment'
  }
  [TexLiteJob]::Attach('${name}', $handle)
} finally { $launcher.Dispose() }
`);
}

export function stopWindowsJob(executionId: string, kind: "Agent" | "Command"): Promise<void> {
  return powershell(`[TexLiteJob]::Stop('${jobName(executionId, kind)}')`);
}

export const attachWindowsAgentJob = (pid: number, id: string): Promise<void> => attachWindowsJob(pid, id, "Agent");
export const stopWindowsAgentJob = (id: string): Promise<void> => stopWindowsJob(id, "Agent");
