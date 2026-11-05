# Where each result file came from

Every file here is a CI artifact of `.github/workflows/spike-s6.yml`, renamed by runner
(`macos26`, `macos27`) and otherwise copied unchanged, except that the NFS helper's one-time
export path (its MOUNT capability) is replaced with `<one-time export path>`; the checks now
leave it out themselves. Files made from this round on also carry their commit
and run in `machine.commit` and `machine.run`; for the earlier ones, this table says. A run's
artifacts stay downloadable on its page for 90 days (`gh run download <run>`).

Every file here was made while the helper lived in `native/mounts/`; it moved to
`spikes/s6-mounts/native/` after the owner decided that Clover mounts nothing (the report's edit 1).
No result was made after the move.

| File | CI run | Commit | What the code had then |
| :- | :- | :- | :- |
| `linux-coherence.json`, `linux-failfast.json` | 41950399657 | `ef2ce0bfb` | events off the link's reader |
| `linux-speed-cached.json`, `linux-speed-owner.json`, `windows-speed-cached.json` | 41950399657 | `ef2ce0bfb` | the same |
| `linux-speed-plain.json`, `linux-speed-nocache.json`, `windows-speed-plain.json`, `windows-speed-nocache.json` | 41944802247 | `c8bf20856` | before events moved off the reader; plain and nocache never use events |
| `linux-strace-*.txt` | 41944802247 | `c8bf20856` | local runs, no mount involved |
| `macos2?-fskit-module.txt` | 41944802247 | `c8bf20856` | excerpts of `probe.txt` (ci-probe.sh) |
| `macos2?-fskit-macfuse-*-coherence.json`, `macos2?-fskit-macfuse-5.5.0-failfast.json` | 41949517437 | `3fa697944` | cgofs with mknod and links |
| `windows-coherence.json`, `windows-failfast.json`, `windows-git.txt`, `windows-speed-git.json` | 41952295145 | `7cb13d508` | Windows-held folders report an x bit |
| `windows-speed-tsc.json` | 41954963974 | `329affbfa` | names keep their case |
| `windows-netvol-speed-tsc.json` | 41965959794 | `eb064e1b0` | the tree as a network volume |
| `windows-tsc.txt` | 41966119424 | `b3c43039e` | the five-layout tsc probe |
| `macos27-gonfs-serial-speed-nfs*.json` | 41954963974 | `329affbfa` | go-nfs as upstream: one connection's calls one after another |
| `macos27-nfs-short-read-log.txt` | 41956550547 | `fb435cc95` | an excerpt of the helper's log (`CLOVER_S6_NFS_DEBUG=1`) |
| `macos27-before-speed-nfs-noac.json`, `-noac-80.json`, `macos27-before-speed-nfs.json` | 41965371714 | `d560a66d5` | go-nfs patch 4, first form: every call concurrent, writes included; `FromHandle` still walked every live handle |
| `macos2?-nfs-failfast-concurrent-writes.json` | 41965371714 | `d560a66d5` | the same: the evidence that concurrent writes let a writer run on for 18–29 s |
| `macos27-before-speed-nfs-noac-writes.json`, `-writes-80.json` | 41967065281 | `c3c3ced36` | patch 4's final form (WRITE and COMMIT in line); `FromHandle` still walked every live handle |
| `macos2?-nfs-coherence.json`, `macos2?-nfs-noac-coherence.json`, `macos2?-nfs-failfast.json` (replaced in this round, below) | 41967065281 | `c3c3ced36` | the same |

After the review (each of these files also records its commit and run in `machine`):

| File | CI run | Commit | What the code had then |
| :- | :- | :- | :- |
| `macos2?-speed-nfs-noac.json`, `-files0-dirs1.json`, `-ac1.json`, `-plain-ac1.json` | 42001348205 | `044fbedb4` | the handle-table fix (patch 5), the MOUNT gate, NFS calls counted. Writes then ran on a queue of their own, which these read-only workloads don't meet; the same run's write rows (240 s for 256 MiB) are not committed |
| `windows-netvol-speed.json`, `windows-netvol-defender-off-speed.json`, `windows-defender.txt` | 42001348205 | `044fbedb4` | the holder follows links that stay in the export |
| `linux-failfast.json`, `linux-coherence.json`, `windows-failfast.json`, `windows-coherence.json`, `windows-git.txt` | 42004174774 | `147f346c9` | everything in this round: the link's liveness and request clock, writes with no short deadline, the capped fake link that trickles, the slow-link case reading a cold file |
| `macos2?-nfs-coherence.json`, `-noac-`, `-ac1-`, `-files0-dirs1-coherence.json`, `macos2?-nfs-failfast.json`, `macos2?-nfs-slowlink-128k-failfast.json`, `macos2?-nfs-kernel-log.txt`, `macos2?-nfs-volume.json`, `macos2?-speed-nfs-noac-writes*.json` | 42004174774 | `147f346c9` | the same, with NFS writes back in line |

Runs 41999748731 (`5b8196c80`), 42001348205 (`044fbedb4`) and 42002469269 (`b15fc7ee3`) also
measured fail-fast, with the fixes that came before; the report quotes them only where they
showed a problem a later commit fixed: the write queue's late errors (18–29 s, both macOS
runs), the Windows write that stalled and the retry that garbled the stream, the fake link's
bursts, and the slow link that macOS's client declared dead with 1 MiB calls.

The `before` files are kept for the comparison in the report (B1): every NFS call there paid for
a walk over all live handles. TABLES.md shows them as their own tables.
