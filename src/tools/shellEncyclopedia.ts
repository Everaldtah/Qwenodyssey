/**
 * Hardcoded shell encyclopedia: a curated, verified reference of Windows
 * PowerShell commands for controlling and inspecting the whole PC. Exposed to
 * the model as the `shell_help` tool so it can look up the EXACT command for a
 * task (logs, processes, network, services, users, disk, …) instead of guessing
 * cmdlet/flag combinations. run_shell executes via Windows PowerShell 5.1.
 */
import type { Tool, ToolResult } from "../types";

export interface ShellCmd {
  cmd: string;
  desc: string;
}
export interface ShellTopic {
  topic: string;
  keywords: string[];
  note?: string;
  commands: ShellCmd[];
}

export const SHELL_ENCYCLOPEDIA: ShellTopic[] = [
  {
    topic: "login & logon history (event logs)",
    keywords: ["login", "logon", "logoff", "signin", "sign in", "who logged", "event log", "winevent", "security log", "failed login", "4624", "4625", "auth", "logins"],
    note: "Reading the Security log requires an elevated (Administrator) shell. Key IDs: 4624 successful logon, 4625 failed logon, 4634 logoff, 4647 user-initiated logoff.",
    commands: [
      { cmd: "Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624; StartTime=(Get-Date).AddDays(-7)} | Select-Object TimeCreated, @{N='User';E={$_.Properties[5].Value}}, @{N='LogonType';E={$_.Properties[8].Value}} | Format-Table -Auto", desc: "Successful logons in the last 7 days (with user + logon type)" },
      { cmd: "Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=(Get-Date).AddDays(-7)} | Select-Object TimeCreated, @{N='User';E={$_.Properties[5].Value}} | Format-Table -Auto", desc: "Failed logon attempts in the last 7 days" },
      { cmd: "Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4624,4634; StartTime=(Get-Date).AddDays(-1)} | Sort-Object TimeCreated | Format-Table TimeCreated, Id -Auto", desc: "Logon/logoff timeline for the last day" },
      { cmd: "Get-WinEvent -LogName Security -MaxEvents 50 | Where-Object Id -in 4624,4625 | Format-Table TimeCreated, Id, Message -Wrap", desc: "Most recent 50 security logon events (no admin filter syntax)" },
      { cmd: "quser", desc: "Currently logged-on interactive sessions" },
      { cmd: "Get-WinEvent -ListLog * | Where-Object RecordCount -gt 0 | Sort-Object RecordCount -Descending | Select-Object LogName, RecordCount -First 20", desc: "Which event logs have entries" },
    ],
  },
  {
    topic: "system information",
    keywords: ["system", "os", "version", "computer info", "build", "spec", "machine", "windows version", "uptime", "boot"],
    commands: [
      { cmd: "Get-ComputerInfo | Select-Object CsName, OsName, OsVersion, OsBuildNumber, WindowsProductName, CsManufacturer, CsModel", desc: "Concise machine + OS summary" },
      { cmd: "[Environment]::OSVersion.Version; (Get-CimInstance Win32_OperatingSystem).Caption", desc: "OS version + edition" },
      { cmd: "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime", desc: "Last boot time (uptime)" },
      { cmd: "Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 15", desc: "Recently installed updates/patches" },
    ],
  },
  {
    topic: "processes",
    keywords: ["process", "processes", "task", "tasklist", "kill", "cpu usage", "memory usage", "running app", "pid"],
    commands: [
      { cmd: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, @{N='MB';E={[int]($_.WorkingSet64/1MB)}}", desc: "Top processes by CPU with memory (MB)" },
      { cmd: "Get-Process -Name <name> | Format-Table Name, Id, CPU, WorkingSet -Auto", desc: "Find a process by name" },
      { cmd: "Stop-Process -Name <name> -Force", desc: "Kill processes by name (Remove-Item-class: confirm first)" },
      { cmd: "Stop-Process -Id <pid> -Force", desc: "Kill one process by PID" },
    ],
  },
  {
    topic: "services",
    keywords: ["service", "services", "daemon", "start service", "stop service", "windows service"],
    commands: [
      { cmd: "Get-Service | Where-Object Status -eq 'Running' | Sort-Object DisplayName | Format-Table Name, DisplayName -Auto", desc: "All running services" },
      { cmd: "Get-Service -Name <name>", desc: "Status of one service" },
      { cmd: "Start-Service -Name <name>; Stop-Service -Name <name>; Restart-Service -Name <name>", desc: "Control a service (needs admin)" },
      { cmd: "Get-Service | Where-Object {$_.StartType -eq 'Automatic' -and $_.Status -ne 'Running'}", desc: "Auto-start services that aren't running" },
    ],
  },
  {
    topic: "network & connectivity",
    keywords: ["network", "ip", "ipconfig", "wifi", "wlan", "dns", "ping", "port", "tcp", "netstat", "connection", "adapter", "internet", "ssid"],
    commands: [
      { cmd: "Get-NetIPConfiguration | Format-List InterfaceAlias, IPv4Address, IPv4DefaultGateway, DnsServer", desc: "IP / gateway / DNS per interface" },
      { cmd: "ipconfig /all", desc: "Full IP configuration (classic)" },
      { cmd: "netsh wlan show interfaces", desc: "Current Wi-Fi SSID, signal, state" },
      { cmd: "Test-NetConnection -ComputerName <host> -Port <port>", desc: "Test reachability of a host:port" },
      { cmd: "Get-NetTCPConnection -State Established | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess | Format-Table -Auto", desc: "Active TCP connections + owning PID" },
      { cmd: "Resolve-DnsName <hostname>", desc: "DNS lookup" },
      { cmd: "Get-NetAdapter | Format-Table Name, Status, LinkSpeed, MacAddress -Auto", desc: "Network adapters" },
    ],
  },
  {
    topic: "internet / bandwidth speed",
    keywords: ["speed", "internet speed", "download speed", "upload speed", "bandwidth", "mbps", "speedtest", "speed test", "how fast", "connection speed", "throughput", "fast is my"],
    commands: [
      { cmd: "$b=10000000; $r=[Net.HttpWebRequest]::Create(\"https://speed.cloudflare.com/__down?bytes=$b\"); $r.Timeout=15000; $r.ReadWriteTimeout=15000; try { $t=Measure-Command { $resp=$r.GetResponse(); $st=$resp.GetResponseStream(); $bu=New-Object byte[] 65536; $n=0; while(($k=$st.Read($bu,0,65536)) -gt 0){$n+=$k}; $resp.Close() }; \"{0:N1} Mbps down\" -f ($n*8/$t.TotalSeconds/1e6) } catch { \"download failed (host blocked or no internet): \" + $_.Exception.Message }", desc: "DOWNLOAD speed — ~10MB sample, streamed with a 15s timeout so it fails fast instead of hanging if the host is blocked. Reports Mbps, or a clear error to fall back on latency/link-speed below" },
      { cmd: "(Test-Connection 1.1.1.1 -Count 4 | Measure-Object -Property ResponseTime -Average).Average", desc: "Average ping latency in ms (to 1.1.1.1)" },
      { cmd: "Get-NetAdapter | Where-Object Status -eq 'Up' | Format-Table Name, LinkSpeed -Auto", desc: "Adapter link rate — this is the NIC's negotiated speed, NOT your internet speed" },
    ],
  },
  {
    topic: "users & accounts",
    keywords: ["user", "users", "account", "accounts", "whoami", "administrator", "group", "members", "permissions", "privilege"],
    commands: [
      { cmd: "whoami /all", desc: "Current user, groups, and privileges" },
      { cmd: "Get-LocalUser | Format-Table Name, Enabled, LastLogon -Auto", desc: "Local user accounts" },
      { cmd: "Get-LocalGroupMember -Group 'Administrators'", desc: "Who is a local Administrator" },
      { cmd: "Get-LocalGroup | Format-Table Name, Description -Auto", desc: "Local groups" },
    ],
  },
  {
    topic: "disk & storage",
    keywords: ["disk", "drive", "storage", "free space", "volume", "partition", "ssd", "filesystem", "space"],
    commands: [
      { cmd: "Get-Volume | Format-Table DriveLetter, FileSystemLabel, FileSystem, @{N='FreeGB';E={[int]($_.SizeRemaining/1GB)}}, @{N='SizeGB';E={[int]($_.Size/1GB)}} -Auto", desc: "Volumes with free / total GB" },
      { cmd: "Get-PhysicalDisk | Format-Table FriendlyName, MediaType, @{N='SizeGB';E={[int]($_.Size/1GB)}}, HealthStatus -Auto", desc: "Physical disks + health" },
      { cmd: "Get-PSDrive -PSProvider FileSystem | Format-Table Name, @{N='UsedGB';E={[int]($_.Used/1GB)}}, @{N='FreeGB';E={[int]($_.Free/1GB)}} -Auto", desc: "Drive usage" },
    ],
  },
  {
    topic: "files, folders & search",
    keywords: ["file", "files", "folder", "directory", "search", "find", "grep", "content", "largest", "size", "recent files", "modified"],
    commands: [
      { cmd: "Get-ChildItem -Path <dir> -Recurse -File | Sort-Object Length -Descending | Select-Object -First 15 FullName, @{N='MB';E={[int]($_.Length/1MB)}}", desc: "Largest files under a directory" },
      { cmd: "Get-ChildItem -Path <dir> -Recurse -File | Where-Object LastWriteTime -gt (Get-Date).AddDays(-7) | Sort-Object LastWriteTime -Descending", desc: "Files changed in the last week" },
      { cmd: "Select-String -Path '<dir>\\*.txt' -Pattern '<regex>'", desc: "Search file contents for a pattern" },
      { cmd: "Get-Content -Path <file> -Tail 50", desc: "Last 50 lines of a file" },
    ],
  },
  {
    topic: "scheduled tasks & startup",
    keywords: ["scheduled task", "schtasks", "cron", "startup", "autorun", "task scheduler", "boot programs"],
    commands: [
      { cmd: "Get-ScheduledTask | Where-Object State -ne 'Disabled' | Format-Table TaskName, State, TaskPath -Auto", desc: "Enabled scheduled tasks" },
      { cmd: "Get-CimInstance Win32_StartupCommand | Format-Table Name, Command, Location -Auto", desc: "Programs that run at startup" },
    ],
  },
  {
    topic: "installed software",
    keywords: ["installed", "software", "programs", "apps", "applications", "uninstall list", "winget", "appx"],
    commands: [
      { cmd: "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object DisplayName | Select-Object DisplayName, DisplayVersion, Publisher | Sort-Object DisplayName", desc: "Installed desktop programs" },
      { cmd: "winget list", desc: "Packages known to winget (if installed)" },
      { cmd: "Get-AppxPackage | Select-Object Name, Version | Sort-Object Name", desc: "Installed Store/UWP apps" },
    ],
  },
  {
    topic: "hardware (cpu / ram / gpu / bios)",
    keywords: ["hardware", "cpu", "processor", "ram", "memory", "gpu", "graphics", "bios", "motherboard", "device", "drivers"],
    commands: [
      { cmd: "Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed", desc: "CPU details" },
      { cmd: "Get-CimInstance Win32_PhysicalMemory | Measure-Object Capacity -Sum | ForEach-Object {[int]($_.Sum/1GB)}", desc: "Total RAM (GB)" },
      { cmd: "Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, @{N='VRAM_GB';E={[int]($_.AdapterRAM/1GB)}}", desc: "GPU(s) + driver" },
      { cmd: "Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SMBIOSBIOSVersion, ReleaseDate", desc: "BIOS info" },
    ],
  },
  {
    topic: "performance & resource usage",
    keywords: ["performance", "cpu load", "memory usage", "ram usage", "counter", "monitor", "utilization", "load"],
    commands: [
      { cmd: "Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 3", desc: "Live CPU utilization samples" },
      { cmd: "Get-CimInstance Win32_OperatingSystem | Select-Object @{N='FreeRAM_GB';E={[int]($_.FreePhysicalMemory/1MB)}}, @{N='TotalRAM_GB';E={[int]($_.TotalVisibleMemorySize/1MB)}}", desc: "Free vs total RAM" },
      { cmd: "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name, @{N='MB';E={[int]($_.WorkingSet64/1MB)}}", desc: "Top memory consumers" },
    ],
  },
  {
    topic: "firewall & security",
    keywords: ["firewall", "security", "defender", "antivirus", "blocked ports", "advfirewall", "rules"],
    commands: [
      { cmd: "Get-NetFirewallProfile | Format-Table Name, Enabled -Auto", desc: "Firewall profiles on/off" },
      { cmd: "Get-NetFirewallRule -Enabled True -Direction Inbound | Select-Object DisplayName, Action -First 30", desc: "Enabled inbound firewall rules" },
      { cmd: "Get-MpComputerStatus | Select-Object AMServiceEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated", desc: "Windows Defender status" },
    ],
  },
  {
    topic: "environment variables",
    keywords: ["environment", "env", "path", "variable", "envvar", "%path%"],
    commands: [
      { cmd: "Get-ChildItem Env: | Sort-Object Name | Format-Table -Auto", desc: "All environment variables" },
      { cmd: "$env:PATH -split ';'", desc: "PATH entries, one per line" },
    ],
  },
  {
    topic: "power & session control",
    keywords: ["shutdown", "restart", "reboot", "sleep", "lock", "logoff", "power"],
    note: "Shutdown/restart are hard-blocked by run_shell for safety; tell the user the command to run themselves if they want it.",
    commands: [
      { cmd: "shutdown /s /t 0", desc: "Shut down now (BLOCKED — user must run it)" },
      { cmd: "shutdown /r /t 0", desc: "Restart now (BLOCKED — user must run it)" },
      { cmd: "rundll32.exe user32.dll,LockWorkStation", desc: "Lock the screen" },
    ],
  },
];

/** Score a topic against a free-text query (keyword/topic/desc match). */
function scoreTopic(q: string, t: ShellTopic): number {
  const ql = q.toLowerCase();
  const terms = ql.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  let score = 0;
  for (const kw of t.keywords) if (ql.includes(kw) || kw.includes(ql)) score += 5;
  for (const term of terms) {
    if (t.topic.toLowerCase().includes(term)) score += 3;
    if (t.keywords.some((k) => k.includes(term))) score += 2;
    if (t.commands.some((c) => c.desc.toLowerCase().includes(term) || c.cmd.toLowerCase().includes(term))) score += 1;
  }
  return score;
}

function renderTopic(t: ShellTopic): string {
  const lines = [`## ${t.topic}`];
  if (t.note) lines.push(`note: ${t.note}`);
  for (const c of t.commands) lines.push(`  • ${c.desc}\n    ${c.cmd}`);
  // Small models tend to "rewrite" these into broken syntax (dropping the $ from
  // PowerShell variables, Python-style `x = ...`). Tell them to copy exactly.
  lines.push(
    "\nRun ONE of these with run_shell EXACTLY as written — copy it character-for-" +
    "character, keep every $ on PowerShell variables, do not rename, reformat, or " +
    "convert to another syntax."
  );
  return lines.join("\n");
}

export const shellHelpTool: Tool = {
  name: "shell_help",
  description:
    "Look up the EXACT, verified Windows PowerShell command(s) for a task before running anything " +
    "you're unsure about (login/event logs, processes, services, network, users, disk, files, " +
    "hardware, performance, firewall, scheduled tasks, software). Call with a topic/query; then run " +
    "the returned command with run_shell.",
  mutating: false,
  async run(args, ctx): Promise<ToolResult> {
    const query = String(args.query || args.topic || "").trim();
    if (!query) {
      const list = SHELL_ENCYCLOPEDIA.map((t) => `- ${t.topic}`).join("\n");
      ctx.log({ tool: "shell_help", query: "(index)" });
      return { ok: true, output: `Shell topics (query one for exact commands):\n${list}` };
    }
    const scored = SHELL_ENCYCLOPEDIA.map((t) => ({ t, s: scoreTopic(query, t) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    // Return the best-matching topic only (plus a 2nd if it's nearly as relevant),
    // so the model gets a tight, actionable answer instead of a wall of text.
    const ranked = scored.filter((x, i) => i === 0 || x.s >= scored[0].s * 0.8).slice(0, 2);
    ctx.log({ tool: "shell_help", query, matched: ranked.length });
    if (ranked.length === 0) {
      const list = SHELL_ENCYCLOPEDIA.map((t) => `- ${t.topic}`).join("\n");
      return { ok: true, output: `No exact match for "${query}". Available topics:\n${list}` };
    }
    return { ok: true, output: ranked.map((x) => renderTopic(x.t)).join("\n\n") };
  },
};
