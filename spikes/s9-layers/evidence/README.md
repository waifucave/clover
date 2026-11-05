# S9 retained CI evidence

Source: https://github.com/waifucave/clover/actions/runs/41942765712

Tested code commit: `12ca3e48fc2ee614d699d45092f1c87d3e83291b`, Electron 45.2.3. Each directory contains the unedited process, memory, crossing and network JSON downloaded from that run. CI artifacts additionally include menu screenshots and fixture-only Chromium netlogs (14-day retention); these larger files are not committed. Interpret negative verdicts and limitations using the [report](../../../docs/research/2026-11-05-s9-layers.md). A green job means the experiment completed, not that the architecture passed.

The Linux preload reports a PID namespace PID; authoritative PID joins use Electron senderFrame.osProcessId. The retained run includes that correction; earlier zero totals are invalid and are not retained here.
