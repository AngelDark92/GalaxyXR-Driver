param(
    [Parameter(Mandatory=$true)][int]$CompanionPid,
    [ValidateSet('measure', 'move', 'close', 'close-main')][string]$Action = 'measure'
)
# Test only: operate on this test's verified Companion PID, never SteamVR.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CurveWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public delegate bool WindowCallback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder title, int length);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  public static IntPtr FindOwnWindow(uint owner, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != owner) return true;
      var text = new System.Text.StringBuilder(512); GetWindowText(hwnd, text, 512);
      if (text.ToString() != title) return true;
      found = hwnd; return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$title = if ($Action -eq 'close-main') { 'Galaxy XR Companion' } else { 'Bitrate Curve' }
$handle = [CurveWindowProbe]::FindOwnWindow($CompanionPid, $title)
if ($handle -eq [IntPtr]::Zero) { throw "Window not found: $title" }
[uint32]$windowPid = 0
[void][CurveWindowProbe]::GetWindowThreadProcessId($handle, [ref]$windowPid)
if ($windowPid -ne $CompanionPid) { throw 'Refusing to operate on another process.' }
if ($Action -eq 'move') { [void][CurveWindowProbe]::MoveWindow($handle, 80, 100, 920, 640, $true) }
if ($Action -eq 'close' -or $Action -eq 'close-main') {
    [void][CurveWindowProbe]::PostMessage($handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
} else {
    $rect = New-Object CurveWindowProbe+Rect
    [void][CurveWindowProbe]::GetWindowRect($handle, [ref]$rect)
    @{ left=$rect.Left; top=$rect.Top; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top } | ConvertTo-Json -Compress
}
