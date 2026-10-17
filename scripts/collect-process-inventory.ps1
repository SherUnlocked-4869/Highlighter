param()

$ErrorActionPreference = 'Stop'
# Never emit CommandLine or ExecutablePath: either can contain user secrets.
$inventory = @(Get-CimInstance Win32_Process)
$rows = foreach ($entry in $inventory) {
    if ($entry.ProcessId -le 0 -or -not $entry.CreationDate) { continue }
    $role = 'native'
    if ($entry.CommandLine -match '--type=([a-z-]+)') { $role = $Matches[1] }
    $item = [ordered]@{
        pid = [int]$entry.ProcessId
        parentPid = [int]$entry.ParentProcessId
        createdAt = $entry.CreationDate.ToUniversalTime().ToString('o')
        name = [string]$entry.Name
        role = $role
        available = $false
        cpuSeconds = $null
        privateBytes = $null
        workingSetBytes = $null
        threadCount = $null
        handleCount = $null
    }
    try {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction Stop
        # Reject a reused PID between the CIM inventory and the metrics read.
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 100) {
            $item.available = $true
            $item.cpuSeconds = [double]$process.TotalProcessorTime.TotalSeconds
            $item.privateBytes = [long]$process.PrivateMemorySize64
            $item.workingSetBytes = [long]$process.WorkingSet64
            $item.threadCount = [int]$process.Threads.Count
            $item.handleCount = [int]$process.HandleCount
        }
    } catch {
        # Protected or exited processes stay explicitly unavailable, not zero.
    }
    [pscustomobject]$item
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
