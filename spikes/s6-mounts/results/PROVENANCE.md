# Where each result file came from

Every file here is a CI artifact of `.github/workflows/spike-s6.yml`, copied unchanged and
renamed by runner (`macos26`, `macos27`). Files made from this round on also carry their commit
and run in `machine.commit` and `machine.run`; for the earlier ones, this table says. A run's
artifacts stay downloadable on its page for 90 days (`gh run download <run>`).

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
| `macos2?-nfs-coherence.json`, `macos2?-nfs-noac-coherence.json`, `macos2?-nfs-failfast.json` | 41967065281 | `c3c3ced36` | the same |

The `before` files are kept for the comparison in the report (B1): every NFS call there paid for
a walk over all live handles. TABLES.md shows them as their own tables.
