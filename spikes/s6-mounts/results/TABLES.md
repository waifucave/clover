# S6 result tables

Rendered from the JSON files in this folder by `bun spikes/s6-mounts/bench/tables.ts spikes/s6-mounts/results`. Cells are cold / warm. A later run of the same workload replaces an earlier one. Tables named `before` are the macOS NFS runs from before the handle-table fix (review B1), kept for comparison; `PROVENANCE.md` says which commit and CI run made each file. The report is [docs/research/2026-11-05-s6-mounts.md](../../../docs/research/2026-11-05-s6-mounts.md).

#### linux: time (cold / warm)

| workload | local | cached +0 | cached +20 | cached +80 | nocache +0 | plain +0 | plain +20 | plain +80 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 75 ms / 15 ms | 444 ms / 86 ms | 964 ms / 165 ms | 2.8 s / 496 ms | 2.8 s / 3.1 s | 736 ms / 106 ms | 26 s / 26 s | 138 s / 138 s |
| tsc-protocol | 2.8 s / 2.5 s | 3.4 s / 2.6 s | 12 s / 2.7 s | 36 s / 2.6 s | 6.4 s / 6.2 s | 3.3 s / 3.3 s | 60 s / 60 s | 435 s / 434 s |
| tsc-core | 25 s / 25 s | 27 s / 25 s | 70 s / 26 s | 193 s / 25 s | 39 s / 39 s | 27 s / 27 s | 225 s / 223 s | timeout / timeout |
| read-256M | 369 ms / 46 ms | 808 ms / 56 ms | 22 s / 60 ms | 84 s / 62 ms | 800 ms / 828 ms | 767 ms / 837 ms | 22 s / 22 s | 89 s / 89 s |
| write-256M | 573 ms / 636 ms | 1.1 s / 1.0 s | 6.6 s / 6.5 s | 22 s / 22 s | 1.1 s / 1.0 s | 1.1 s / 1.0 s | 6.4 s / 6.4 s | 22 s / 22 s |
| copy-out | 70 ms / 35 ms | 302 ms / 50 ms | 2.9 s / 47 ms | 10 s / 54 ms | 333 ms / 313 ms | 112 ms / 91 ms | 4.5 s / 4.3 s | 27 s / 27 s |
| copy-in | 68 ms / 38 ms | 252 ms / 229 ms | 10 s / 10 s | 40 s / 40 s | 289 ms / 273 ms | 195 ms / 203 ms | 11 s / 11 s | 48 s / 48 s |
| git-status, other owner | – / – | 1.7 s / 65 ms | 83 s / 267 ms | 321 s / 1.4 s | – / – | – / – | – / – | – / – |
| git-status-minimal, other owner | – / – | 256 ms / 61 ms | 856 ms / 142 ms | 2.7 s / 467 ms | – / – | – / – | – / – | – / – |

#### linux: requests that crossed the link (cold / warm)

| workload | cached +0 | cached +20 | cached +80 | nocache +0 | plain +0 | plain +20 | plain +80 |
| :- | -: | -: | -: | -: | -: | -: | -: |
| git-status | 32 / 5 | 32 / 5 | 32 / 6 | 28282 / 28283 | 4749 / 39 | 5083 / 5084 | 6447 / 6457 |
| tsc-protocol | 437 / 0 | 437 / 0 | 437 / 0 | 15154 / 15145 | 2147 / 2138 | 2785 / 2772 | 5375 / 5358 |
| tsc-core | 2107 / 0 | 2107 / 0 | 2107 / 0 | 60740 / 60700 | 7085 / 7045 | 9649 / 9588 | 7415 / 7407 |
| read-256M | 2050 / 0 | 2050 / 0 | 2050 / 0 | 2307 / 2306 | 2050 / 2049 | 2071 / 2069 | 2114 / 2112 |
| write-256M | 261 / 260 | 260 / 260 | 260 / 260 | 261 / 260 | 261 / 260 | 260 / 260 | 260 / 260 |
| copy-out | 124 / 0 | 124 / 0 | 124 / 0 | 1089 / 1087 | 132 / 120 | 211 / 206 | 331 / 326 |
| copy-in | 612 / 611 | 613 / 614 | 613 / 614 | 945 / 945 | 607 / 606 | 633 / 633 | 714 / 714 |
| git-status, other owner | 3993 / 12 | 3993 / 12 | 3993 / 19 | – / – | – / – | – / – | – / – |
| git-status-minimal, other owner | 32 / 5 | 32 / 5 | 32 / 6 | – / – | – / – | – / – | – / – |

#### windows: time (cold / warm)

| workload | local | cached +0 | cached +20 | cached +80 | nocache +0 | plain +0 | plain +20 | plain +80 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: |
| read-256M | 75 ms / 75 ms | 606 ms / 483 ms | 8.3 s / 8.3 s | 24 s / 24 s | 922 ms / 887 ms | 936 ms / 867 ms | 8.4 s / 8.4 s | 25 s / 25 s |
| write-256M | 1.1 s / 1.1 s | 1.5 s / 1.2 s | 17 s / 17 s | 49 s / 49 s | 1.8 s / 1.5 s | 1.8 s / 1.7 s | 17 s / 17 s | 49 s / 50 s |
| copy-out | 60 ms / 60 ms | 405 ms / 146 ms | 8.1 s / 7.7 s | 24 s / 23 s | 982 ms / 963 ms | 303 ms / 270 ms | 13 s / 13 s | 66 s / 66 s |
| copy-in | 61 ms / 60 ms | 479 ms / 410 ms | 27 s / 27 s | 80 s / 80 s | 1.5 s / 1.5 s | 597 ms / 577 ms | 26 s / 26 s | 91 s / 91 s |
| tsc-core | 16 s / 15 s | fails / fails | fails / fails | fails / fails | fails / fails | fails / fails | timeout / timeout | timeout / timeout |
| tsc-protocol | 2.1 s / 1.9 s | fails / fails | fails / fails | fails / fails | fails / fails | fails / fails | fails / fails | timeout / timeout |
| git-status | 42 ms / 43 ms | 697 ms / 186 ms | 2.6 s / 2.5 s | 8.1 s / 8.4 s | fails / fails | 339 ms / 150 ms | 11 s / 11 s | 49 s / 49 s |

#### windows: requests that crossed the link (cold / warm)

| workload | cached +0 | cached +20 | cached +80 | nocache +0 | plain +0 | plain +20 | plain +80 |
| :- | -: | -: | -: | -: | -: | -: | -: |
| read-256M | 259 / 257 | 259 / 257 | 259 / 257 | 266 / 266 | 259 / 257 | 259 / 259 | 259 / 259 |
| write-256M | 518 / 517 | 517 / 517 | 517 / 517 | 529 / 529 | 518 / 518 | 517 / 517 | 517 / 518 |
| copy-out | 247 / 243 | 247 / 243 | 247 / 243 | 2123 / 2123 | 259 / 243 | 418 / 415 | 694 / 694 |
| copy-in | 903 / 899 | 963 / 964 | 963 / 964 | 3348 / 3348 | 846 / 846 | 932 / 932 | 1085 / 1085 |
| tsc-core | 5252 / 4931 | 5252 / 4931 | 5252 / 4931 | 127724 / 127725 | 10509 / 10507 | 18991 / 18993 | 6345 / 6348 |
| tsc-protocol | 873 / 568 | 873 / 568 | 873 / 568 | 14890 / 14891 | 1343 / 1345 | 2539 / 2536 | 6342 / 6346 |
| git-status | 64 / 79 | 64 / 79 | 81 / 89 | 22 / 22 | 521 / 55 | 765 / 757 | 1220 / 1230 |

Failures on windows:
- git-status mount nocache +0 cold: fatal: Unable to read current working directory: No such file or directory
- git-status mount nocache +0 warm: fatal: Unable to read current working directory: No such file or directory
- tsc-protocol mount nocache +0 cold: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-protocol mount nocache +0 warm: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-core mount nocache +0 cold: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-core mount nocache +0 warm: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-protocol mount cached +0 cold: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-protocol mount cached +0 warm: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-core mount cached +0 cold: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-core mount cached +0 warm: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-protocol mount cached +20 cold: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-protocol mount cached +20 warm: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-core mount cached +20 cold: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-core mount cached +20 warm: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-protocol mount cached +80 cold: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-protocol mount cached +80 warm: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-core mount cached +80 cold: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-core mount cached +80 warm: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-protocol mount plain +0 cold: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-protocol mount plain +0 warm: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-core mount plain +0 cold: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-core mount plain +0 warm: scripts/dev-daemon-lib.ts(2,25): error TS2307: Cannot find module 'node:os' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(3,31): error TS2307: Cannot find module 'node:path' or its corresponding type declarations. | scripts/dev-daemon-lib.ts(64,36): error TS2503: Cannot find namespace 'NodeJS'.
- tsc-protocol mount plain +20 cold: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.
- tsc-protocol mount plain +20 warm: packages/protocol/test/parity-fixtures.test.ts(77,42): error TS2339: Property 'dir' does not exist on type 'ImportMeta'. | packages/protocol/test/parity-fixtures.test.ts(78,57): error TS7006: Parameter 'f' implicitly has an 'any' type. | packages/protocol/test/session-mode.test.ts(1,40): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations.

#### macos27-gonfs-serial-nfs: time (cold / warm)

| workload | local | cached +0 | cached +20 | cached +80 | plain +0 | plain +20 | plain +80 |
| :- | -: | -: | -: | -: | -: | -: | -: |
| git-status | 257 ms / 26 ms | 8.3 s / 11 s | 10 s / 9.5 s | 13 s / 9.6 s | 2.5 s / 65 ms | 206 s / 190 s | timeout / timeout |
| tsc-protocol | 4.9 s / 2.6 s | 4.0 s / 3.1 s | 14 s / 3.3 s | fails / 37 s | 2.4 s / 1.5 s | 74 s / 20 s | 377 s / 107 s |
| tsc-core | 26 s / 23 s | 46 s / 46 s | 98 s / 91 s | fails / 225 s | 21 s / 19 s | 282 s / 196 s | – / – |
| read-256M | 243 ms / 46 ms | 1.3 s / 133 ms | fails / fails | fails / fails | 933 ms / 54 ms | 7.9 s / 95 ms | – / – |
| write-256M | 318 ms / 211 ms | 1.1 s / 1.0 s | 14 s / 14 s | 46 s / 46 s | 787 ms / 529 ms | 15 s / 14 s | – / – |
| copy-out | 105 ms / 51 ms | 895 ms / 188 ms | 4.0 s / 166 ms | 12 s / 209 ms | 227 ms / 42 ms | 6.1 s / 202 ms | – / – |
| copy-in | 66 ms / 38 ms | 851 ms / 945 ms | 28 s / 28 s | 96 s / 95 s | 335 ms / 321 ms | 25 s / 25 s | – / – |

#### macos27-gonfs-serial-nfs: requests that crossed the link (cold / warm)

| workload | cached +0 | cached +20 | cached +80 | plain +0 | plain +20 | plain +80 |
| :- | -: | -: | -: | -: | -: | -: |
| git-status | 73 / 10 | 73 / 10 | 74 / 10 | 4869 / 12 | 7524 / 6938 | 6872 / 6868 |
| tsc-protocol | 381 / 0 | 381 / 0 | 19 / 361 | 2088 / 410 | 2670 / 659 | 4300 / 1212 |
| tsc-core | 2026 / 1973 | 2026 / 1973 | 18 / 2007 | 6984 / 4329 | 9508 / 6374 | – / – |
| read-256M | 265 / 0 | 18 / 20 | 10 / 7 | 264 / 0 | 274 / 1 | – / – |
| write-256M | 523 / 516 | 524 / 517 | 522 / 516 | 523 / 515 | 528 / 522 | – / – |
| copy-out | 130 / 0 | 130 / 0 | 130 / 0 | 138 / 0 | 221 / 5 | – / – |
| copy-in | 984 / 983 | 1295 / 1289 | 1336 / 1333 | 978 / 970 | 1160 / 1163 | – / – |

Failures on macos27-gonfs-serial-nfs:
- read-256M mount cached +20 cold: {"ok":false,"ms":443.330625,"bytes":1048576,"files":0,"code":"ETIMEDOUT","message":"ETIMEDOUT: connection timed out, read"}
- read-256M mount cached +20 warm: {"ok":false,"ms":488.205666,"bytes":17825792,"files":0,"code":"ETIMEDOUT","message":"ETIMEDOUT: connection timed out, read"}
- tsc-protocol mount cached +80 cold: } |  | Node.js v24.22.1
- tsc-core mount cached +80 cold: } |  | Node.js v24.22.1
- read-256M mount cached +80 cold: {"ok":false,"ms":863.633834,"bytes":1048576,"files":0,"code":"ETIMEDOUT","message":"ETIMEDOUT: connection timed out, read"}
- read-256M mount cached +80 warm: {"ok":false,"ms":598.8463330000001,"bytes":7340032,"files":0,"code":"ETIMEDOUT","message":"ETIMEDOUT: connection timed out, read"}

#### macos27-before-nfs: time (cold / warm)

| workload | local | cached +0 | cached +20 | cached +80 | plain +20 |
| :- | -: | -: | -: | -: | -: |
| git-status | 114 ms / 22 ms | 7.1 s / 8.0 s | 8.0 s / 8.6 s | 11 s / 9.0 s | 39 s / 37 s |
| tsc-core | 29 s / 21 s | 37 s / 34 s | 91 s / 92 s | – / – | – / – |
| read-256M | 205 ms / 44 ms | 494 ms / 57 ms | 783 ms / 59 ms | 1.9 s / 87 ms | 913 ms / 47 ms |
| copy-in | 145 ms / 46 ms | 483 ms / 484 ms | 28 s / 28 s | – / – | – / – |
| tsc-protocol | – / – | – / – | – / – | 39 s / 2.6 s | – / – |
| write-256M | – / – | 710 ms / 838 ms | 15 s / 14 s | 47 s / 46 s | – / – |

#### macos27-before-nfs: requests that crossed the link (cold / warm)

| workload | cached +0 | cached +20 | cached +80 | plain +20 |
| :- | -: | -: | -: | -: |
| git-status | 75 / 15 | 79 / 16 | 78 / 14 | 5238 / 5112 |
| tsc-core | 2026 / 1973 | 2027 / 1973 | – / – | – / – |
| read-256M | 266 / 0 | 266 / 0 | 266 / 0 | 269 / 0 |
| copy-in | 1113 / 1105 | 1619 / 1632 | – / – | – / – |
| tsc-protocol | – / – | – / – | 382 / 0 | – / – |
| write-256M | 526 / 518 | 526 / 517 | 526 / 519 | – / – |

#### windows-netvol: time (cold / warm)

| workload | local | cached +0 | cached +20 |
| :- | -: | -: | -: |
| tsc-core | – / – | 20 s / 20 s | 109 s / 90 s |
| git-status | 45 ms / 45 ms | 4.1 s / 178 ms | 3.4 s / 2.8 s |
| tsc-protocol | 2.9 s / 2.8 s | 5.5 s / 3.9 s | 33 s / 18 s |
| read-256M | 102 ms / 100 ms | 1.2 s / 1.2 s | 10 s / 11 s |
| write-256M | 534 ms / 631 ms | 970 ms / 1.2 s | 17 s / 17 s |
| copy-out | 98 ms / 109 ms | 1.7 s / 428 ms | 9.2 s / 7.8 s |
| copy-in | 101 ms / 101 ms | 1.3 s / 1.3 s | 35 s / 34 s |

#### windows-netvol: requests that crossed the link (cold / warm)

| workload | cached +0 | cached +20 |
| :- | -: | -: |
| tsc-core | 2982 / 2509 | 2982 / 2509 |
| git-status | 76 / 66 | 67 / 86 |
| tsc-protocol | 917 / 471 | 917 / 471 |
| read-256M | 259 / 257 | 259 / 257 |
| write-256M | 517 / 517 | 517 / 517 |
| copy-out | 246 / 242 | 246 / 242 |
| copy-in | 1108 / 1112 | 1208 / 1201 |

#### windows-netvol-defender-off: time (cold / warm)

| workload | local | cached +0 |
| :- | -: | -: |
| git-status | – / – | 1.4 s / 188 ms |
| tsc-protocol | – / – | 5.5 s / 4.1 s |
| read-256M | – / – | 1.4 s / 1.1 s |

#### windows-netvol-defender-off: requests that crossed the link (cold / warm)

| workload | cached +0 |
| :- | -: |
| git-status | 66 / 71 |
| tsc-protocol | 917 / 471 |
| read-256M | 259 / 257 |

#### macos27-nfs: time (cold / warm)

| workload | local | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +0 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +20 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +80 | cached, actimeo=1 +0 | cached, actimeo=1 +20 | cached, actimeo=1 +80 | cached, noac +0 | cached, noac +20 | cached, noac +80 | plain, actimeo=1 +20 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 73 ms / 38 ms | 1.4 s / 265 ms | 2.6 s / 803 ms | 5.7 s / 1.7 s | 860 ms / 62 ms | 2.4 s / 765 ms | 5.6 s / 1.6 s | 2.3 s / 1.2 s | 3.0 s / 1.5 s | 6.4 s / 2.2 s | 39 s / 36 s |
| tsc-protocol | 2.5 s / 1.4 s | 3.9 s / 2.1 s | 14 s / 2.2 s | 36 s / 2.1 s | 4.1 s / 2.6 s | 14 s / 1.7 s | 37 s / 2.0 s | 4.0 s / 3.4 s | 15 s / 2.6 s | 38 s / 3.1 s | – / – |
| write-256M | – / – | – / – | – / – | – / – | – / – | – / – | – / – | 1.2 s / 1.2 s | 14 s / 13 s | 46 s / 46 s | – / – |
| copy-in | – / – | – / – | – / – | – / – | – / – | – / – | – / – | 1.1 s / 913 ms | 29 s / 30 s | – / – | – / – |

#### macos27-nfs: requests that crossed the link (cold / warm)

| workload | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +0 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +20 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +80 | cached, actimeo=1 +0 | cached, actimeo=1 +20 | cached, actimeo=1 +80 | cached, noac +0 | cached, noac +20 | cached, noac +80 | plain, actimeo=1 +20 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 68 / 16 | 79 / 18 | 80 / 16 | 68 / 13 | 77 / 19 | 79 / 16 | 71 / 16 | 80 / 19 | 80 / 17 | 5260 / 5119 |
| tsc-protocol | 373 / 0 | 382 / 0 | 382 / 0 | 373 / 0 | 382 / 0 | 382 / 0 | 376 / 0 | 382 / 0 | 382 / 0 | – / – |
| write-256M | – / – | – / – | – / – | – / – | – / – | – / – | 523 / 519 | 525 / 522 | 527 / 521 | – / – |
| copy-in | – / – | – / – | – / – | – / – | – / – | – / – | 1135 / 1120 | 1739 / 1752 | – / – | – / – |

#### macos27-nfs: NFS calls the kernel made, and the helper's time on them (cold / warm)

| workload | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +0 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +20 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +80 | cached, actimeo=1 +0 | cached, actimeo=1 +20 | cached, actimeo=1 +80 | cached, noac +0 | cached, noac +20 | cached, noac +80 | plain, actimeo=1 +20 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 9678 (1.8 s) / 4222 (177 ms) | 9761 (3.1 s) / 4958 (567 ms) | 9738 (7.8 s) / 5132 (1.5 s) | 5517 (1.1 s) / 32 (11 ms) | 5545 (3.5 s) / 4851 (612 ms) | 5624 (7.8 s) / 4898 (1.5 s) | 34989 (2.0 s) / 29294 (538 ms) | 35016 (3.8 s) / 29516 (889 ms) | 35030 (8.1 s) / 29098 (1.8 s) | 6176 (146 s) / 5738 (137 s) |
| tsc-protocol | 4252 (1.4 s) / 1775 (33 ms) | 4373 (12 s) / 1776 (23 ms) | 4576 (34 s) / 1776 (29 ms) | 2597 (1.6 s) / 509 (13 ms) | 2801 (12 s) / 424 (7 ms) | 3002 (34 s) / 475 (13 ms) | 18379 (1.4 s) / 15838 (184 ms) | 18413 (12 s) / 15832 (142 ms) | 18405 (35 s) / 15838 (168 ms) | – / – |
| write-256M | – / – | – / – | – / – | – / – | – / – | – / – | 291 (1.1 s) / 290 (1.1 s) | 318 (14 s) / 290 (13 s) | 319 (47 s) / 290 (46 s) | – / – |
| copy-in | – / – | – / – | – / – | – / – | – / – | – / – | 3839 (778 ms) / 3729 (644 ms) | 4483 (37 s) / 4444 (37 s) | – / – | – / – |

#### macos26-nfs: time (cold / warm)

| workload | local | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +0 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +20 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +80 | cached, actimeo=1 +0 | cached, actimeo=1 +20 | cached, actimeo=1 +80 | cached, noac +0 | cached, noac +20 | cached, noac +80 | plain, actimeo=1 +20 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 107 ms / 22 ms | 926 ms / 120 ms | 2.2 s / 591 ms | 5.2 s / 1.4 s | 736 ms / 30 ms | 2.2 s / 551 ms | 5.2 s / 1.6 s | 1.5 s / 778 ms | 2.5 s / 1.2 s | 6.3 s / 2.0 s | 36 s / 36 s |
| tsc-protocol | 2.3 s / 1.4 s | 2.9 s / 1.6 s | 11 s / 1.4 s | 36 s / 1.4 s | 2.5 s / 1.5 s | 13 s / 4.1 s | 36 s / 31 s | 3.6 s / 2.6 s | 13 s / 5.6 s | 37 s / 27 s | – / – |
| write-256M | – / – | – / – | – / – | – / – | – / – | – / – | – / – | 750 ms / 640 ms | 15 s / 14 s | 46 s / 46 s | – / – |
| copy-in | – / – | – / – | – / – | – / – | – / – | – / – | – / – | 759 ms / 503 ms | 30 s / 31 s | – / – | – / – |

#### macos26-nfs: requests that crossed the link (cold / warm)

| workload | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +0 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +20 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +80 | cached, actimeo=1 +0 | cached, actimeo=1 +20 | cached, actimeo=1 +80 | cached, noac +0 | cached, noac +20 | cached, noac +80 | plain, actimeo=1 +20 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 67 / 15 | 80 / 18 | 79 / 15 | 67 / 13 | 78 / 17 | 79 / 17 | 68 / 16 | 80 / 18 | 80 / 16 | 5221 / 5110 |
| tsc-protocol | 373 / 0 | 382 / 0 | 382 / 0 | 373 / 0 | 382 / 84 | 384 / 319 | 373 / 0 | 382 / 108 | 383 / 275 | – / – |
| write-256M | – / – | – / – | – / – | – / – | – / – | – / – | 518 / 519 | 527 / 520 | 527 / 519 | – / – |
| copy-in | – / – | – / – | – / – | – / – | – / – | – / – | 1111 / 1101 | 1759 / 1770 | – / – | – / – |

#### macos26-nfs: NFS calls the kernel made, and the helper's time on them (cold / warm)

| workload | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +0 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +20 | cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 +80 | cached, actimeo=1 +0 | cached, actimeo=1 +20 | cached, actimeo=1 +80 | cached, noac +0 | cached, noac +20 | cached, noac +80 | plain, actimeo=1 +20 |
| :- | -: | -: | -: | -: | -: | -: | -: | -: | -: | -: |
| git-status | 9672 (1.0 s) / 4216 (81 ms) | 9733 (3.0 s) / 4936 (478 ms) | 9726 (7.3 s) / 5112 (1.3 s) | 5516 (828 ms) / 31 (5 ms) | 5564 (3.2 s) / 4850 (448 ms) | 5595 (7.3 s) / 4903 (1.5 s) | 34974 (1.5 s) / 29072 (351 ms) | 35019 (2.6 s) / 29079 (716 ms) | 35029 (8.1 s) / 29520 (1.6 s) | 6143 (131 s) / 5666 (135 s) |
| tsc-protocol | 4239 (1.0 s) / 1760 (21 ms) | 4355 (9.9 s) / 1745 (19 ms) | 4581 (34 s) / 1767 (19 ms) | 2541 (762 ms) / 408 (7 ms) | 2780 (11 s) / 606 (2.4 s) | 2998 (34 s) / 1178 (28 s) | 18374 (1.1 s) / 15835 (131 ms) | 18414 (11 s) / 15945 (2.7 s) | 18415 (35 s) / 16127 (24 s) | – / – |
| write-256M | – / – | – / – | – / – | – / – | – / – | – / – | 279 (673 ms) / 290 (560 ms) | 319 (15 s) / 292 (14 s) | 317 (47 s) / 288 (46 s) | – / – |
| copy-in | – / – | – / – | – / – | – / – | – / – | – / – | 3113 (494 ms) / 3702 (346 ms) | 4481 (37 s) / 4524 (38 s) | – / – | – / – |

#### fail-fast: linux-failfast (linux 7.0.0-1019-azure, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1503 ms | EHOSTDOWN: EHOSTDOWN: host is down, read | EHOSTDOWN in <1 ms | 0 | 118 ms |
| read+reset | 4 ms | EIO: EIO: i/o error, read | EHOSTDOWN in <1 ms | 0 | 120 ms |
| read+kill | 7 ms | EIO: EIO: i/o error, read | EHOSTDOWN in <1 ms | 0 | 260 ms |
| read+freeze | 1506 ms | EHOSTDOWN: EHOSTDOWN: host is down, read | EHOSTDOWN in <1 ms | 0 | 111 ms |
| write+blackhole | 1505 ms | EHOSTDOWN: EHOSTDOWN: host is down, write | EHOSTDOWN in <1 ms | 0 | 110 ms |
| write+kill | 8 ms | EHOSTDOWN: EHOSTDOWN: host is down, write | EHOSTDOWN in <1 ms | 0 | 262 ms |
| git+blackhole | 1527 ms | fatal: .git/index: index file open failed: Host is down | EHOSTDOWN in <1 ms | 0 | 120 ms |
| tsc+blackhole | 1532 ms | node:internal/modules/cjs/loader:1568 | EHOSTDOWN in <1 ms | 0 | 117 ms |
| idle+blackhole | 1418 ms (first call) | EHOSTDOWN | EHOSTDOWN in <1 ms | 0 | 64 ms |
| offline-at-start | – | EHOSTDOWN | EHOSTDOWN in <1 ms | 0 | 228 ms |
| read+helper-crash | 4 ms | EIO: EIO: i/o error, read | ok in 0 ms | 0 | 152 ms |
| slow link (2000 kbit/s each way, +0–20 ms jitter, 256 KiB buffer) | write: ok in 34 s; read: ok in 34 s | false offline: 0, request timeouts: 0 | – | 0 | – |

#### fail-fast: macos26-fskit-macfuse-5.5.0-failfast (darwin 25.6.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1708 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 1 ms | 0 | 125 ms |
| read+reset | 29 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 42 ms | 0 | 112 ms |
| read+kill | 39 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in <1 ms | 0 | 238 ms |
| read+freeze | 1628 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 42 ms | 0 | 161 ms |
| write+blackhole | 2 ms | ENOSYS: ENOSYS: function not implemented, open '/Users/runner/work/_temp/s6/tree | EHOSTUNREACH in 1421 ms | 0 | 137 ms |
| write+kill | 6 ms | ENOSYS: ENOSYS: function not implemented, open '/Users/runner/work/_temp/s6/tree | EHOSTUNREACH in 2 ms | 0 | 269 ms |
| git+blackhole | 1520 ms | fatal: unable to get current working directory: No route to host | EHOSTUNREACH in 1 ms | 0 | 89 ms |
| tsc+blackhole | 1624 ms | node:internal/modules/cjs/loader:1568 | EHOSTUNREACH in <1 ms | 0 | 98 ms |
| idle+blackhole | 1422 ms (first call) | EHOSTUNREACH | EHOSTUNREACH in 2 ms | 0 | 23 ms |
| offline-at-start | – | EHOSTUNREACH | EHOSTUNREACH in 1 ms | 0 | 165 ms |
| read+helper-crash | 3490 ms | ENXIO: ENXIO: no such device or address, read | ok in 0 ms | 0 | 466 ms |

#### fail-fast: macos26-nfs-failfast-concurrent-writes (darwin 25.6.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1556 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 93 ms |
| read+reset | 20 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 112 ms |
| read+kill | 14 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 217 ms |
| read+freeze | 1564 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 151 ms |
| write+blackhole | 22503 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 95 ms |
| write+kill | 29079 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 405 ms |
| git+blackhole | 1606 ms | fatal: .git/index: index file open failed: Input/output error | EIO in <1 ms | 0 | 92 ms |
| tsc+blackhole | 1650 ms | node:internal/modules/cjs/loader:1568 | EIO in <1 ms | 0 | 94 ms |
| idle+blackhole | 1462 ms (first call) | EIO | EIO in <1 ms | 0 | 91 ms |
| offline-at-start | – | EIO | EIO in <1 ms | 0 | 161 ms |
| read+helper-crash | 1580 ms | ETIMEDOUT: ETIMEDOUT: connection timed out, read | EIO in 5392 ms | 0 | 106 ms |

NFS mounted as: user

#### fail-fast: macos26-nfs-failfast (darwin 25.6.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1572 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 136 ms |
| read+reset | 8 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 137 ms |
| read+kill | 4 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 112 ms |
| read+freeze | 1576 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 163 ms |
| write+blackhole | 1580 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 145 ms |
| write+kill | 21 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 296 ms |
| git+blackhole | 1631 ms | fatal: .git/index: index file open failed: Input/output error | EIO in <1 ms | 0 | 147 ms |
| tsc+blackhole | 1656 ms | node:internal/modules/cjs/loader:1568 | EIO in <1 ms | 0 | 103 ms |
| idle+blackhole | 1471 ms (first call) | EIO | EIO in <1 ms | 0 | 106 ms |
| offline-at-start | – | EIO | EIO in <1 ms | 0 | 194 ms |
| read+helper-crash | 1032 ms (the daemon's force-unmount at the helper's death took 1028 ms) | EIO: EIO: i/o error, read | ENOENT in <1 ms | 0 | 103 ms |
| slow link (2000 kbit/s each way, +0–20 ms jitter, 256 KiB buffer) | write: ok in 35 s; read: ok in 34 s | false offline: 0, request timeouts: 0 | – | 0 | – |

NFS mounted as: user; timeo=110, rsize=1048576, readahead=16; tree root 700

#### fail-fast: macos26-nfs-slowlink-128k-failfast (darwin 25.6.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| slow link (2000 kbit/s each way, +0–20 ms jitter, 256 KiB buffer) | write: ok in 40 s; read: ok in 35 s | false offline: 0, request timeouts: 0 | – | 0 | – |

NFS mounted as: user; timeo=110, rsize=131072, readahead=4; tree root 700

#### fail-fast: macos27-fskit-macfuse-5.5.0-failfast (darwin 27.0.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1622 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 2 ms | 0 | 107 ms |
| read+reset | 20 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 25 ms | 0 | 107 ms |
| read+kill | 16 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 1 ms | 0 | 257 ms |
| read+freeze | 1670 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in 2 ms | 0 | 169 ms |
| write+blackhole | 2 ms | ENOSYS: ENOSYS: function not implemented, open '/Users/runner/work/_temp/s6/tree | EHOSTUNREACH in 1349 ms | 0 | 168 ms |
| write+kill | 15 ms | ENOSYS: ENOSYS: function not implemented, open '/Users/runner/work/_temp/s6/tree | EHOSTUNREACH in 2 ms | 0 | 299 ms |
| git+blackhole | 1605 ms | fatal: unable to get current working directory: No route to host | EHOSTUNREACH in 2 ms | 0 | 70 ms |
| tsc+blackhole | 1639 ms | node:internal/modules/cjs/loader:1568 | EHOSTUNREACH in 2 ms | 0 | 76 ms |
| idle+blackhole | 1413 ms (first call) | EHOSTUNREACH | EHOSTUNREACH in 3 ms | 0 | 15 ms |
| offline-at-start | – | EHOSTUNREACH | EHOSTUNREACH in 1 ms | 0 | 346 ms |
| read+helper-crash | 157 ms | ENXIO: ENXIO: no such device or address, read | ok in 1 ms | 0 | 427 ms |

#### fail-fast: macos27-nfs-failfast-concurrent-writes (darwin 27.0.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1681 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 96 ms |
| read+reset | 4 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 110 ms |
| read+kill | 5 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 184 ms |
| read+freeze | 1557 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 112 ms |
| write+blackhole | 18233 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 92 ms |
| write+kill | 29111 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 393 ms |
| git+blackhole | 1586 ms | fatal: .git/index: index file open failed: Input/output error | EIO in <1 ms | 0 | 143 ms |
| tsc+blackhole | 1625 ms | node:internal/modules/cjs/loader:1568 | EIO in <1 ms | 0 | 92 ms |
| idle+blackhole | 1495 ms (first call) | EIO | EIO in <1 ms | 0 | 105 ms |
| offline-at-start | – | EIO | EIO in <1 ms | 0 | 456 ms |
| read+helper-crash | 13028 ms | ENXIO: ENXIO: no such device or address, read | ENOENT in <1 ms | 0 | 163 ms |

NFS mounted as: user

#### fail-fast: macos27-nfs-failfast (darwin 27.0.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1537 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 100 ms |
| read+reset | 4 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 96 ms |
| read+kill | 13 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 245 ms |
| read+freeze | 1579 ms | EIO: EIO: i/o error, read | EIO in <1 ms | 0 | 117 ms |
| write+blackhole | 1579 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 95 ms |
| write+kill | 16 ms | EIO: EIO: i/o error, write | EIO in <1 ms | 0 | 288 ms |
| git+blackhole | 1621 ms | fatal: .git/index: index file open failed: Input/output error | EIO in <1 ms | 0 | 142 ms |
| tsc+blackhole | 1539 ms | node:internal/modules/cjs/loader:1568 | EIO in <1 ms | 0 | 105 ms |
| idle+blackhole | 1489 ms (first call) | EIO | EIO in <1 ms | 0 | 103 ms |
| offline-at-start | – | EIO | EIO in <1 ms | 0 | 251 ms |
| read+helper-crash | 1020 ms (the daemon's force-unmount at the helper's death took 1018 ms) | EIO: EIO: i/o error, read | ENOENT in <1 ms | 0 | 116 ms |
| slow link (2000 kbit/s each way, +0–20 ms jitter, 256 KiB buffer) | write: **failed** after 30 s: ENXIO: no such device or address, fsync; read: **failed** after 128 ms: ENOENT: no such file or directory, open '/Users/runner/work/_temp/s6/n | false offline: 0, request timeouts: 0 | – | 0 | – |

NFS mounted as: user; timeo=110, rsize=1048576, readahead=16; tree root 700

#### fail-fast: macos27-nfs-slowlink-128k-failfast (darwin 27.0.0, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| slow link (2000 kbit/s each way, +0–20 ms jitter, 256 KiB buffer) | write: ok in 40 s; read: ok in 35 s | false offline: 0, request timeouts: 0 | – | 0 | – |

NFS mounted as: user; timeo=110, rsize=131072, readahead=4; tree root 700

#### fail-fast: windows-failfast (win32 10.0.26100, plain, +20 ms)

| scenario | in-flight op fails after | what the program saw | a new op while away | stuck processes | works again after |
| :- | -: | :- | :- | -: | -: |
| read+blackhole | 1557 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in <1 ms | 0 | 177 ms |
| read+reset | 10 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in <1 ms | 0 | 179 ms |
| read+kill | 16 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, read | EHOSTUNREACH in <1 ms | 0 | 286 ms |
| write+blackhole | 1544 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, write | EHOSTUNREACH in <1 ms | 0 | 178 ms |
| write+kill | 11 ms | EHOSTUNREACH: EHOSTUNREACH: host is unreachable, write | EHOSTUNREACH in <1 ms | 0 | 272 ms |
| git+blackhole | 1519 ms | fatal: unable to get current working directory: No such file or directory | EHOSTUNREACH in <1 ms | 0 | 177 ms |
| tsc+blackhole | 1565 ms | node:internal/modules/cjs/loader:1568 | EHOSTUNREACH in <1 ms | 0 | 177 ms |
| idle+blackhole | 1372 ms (first call) | EHOSTUNREACH | EHOSTUNREACH in <1 ms | 0 | 179 ms |
| offline-at-start | – | EHOSTUNREACH | EHOSTUNREACH in <1 ms | 0 | 427 ms |
| read+helper-crash | 10 ms | ECANCELED: ECANCELED: operation canceled, read | ENOENT in <1 ms | 0 | 273 ms |
| slow link (2000 kbit/s each way, +0–20 ms jitter, 256 KiB buffer) | write: ok in 35 s; read: ok in 34 s | false offline: 0, request timeouts: 0 | – | 0 | – |

#### volume: macos26-nfs-volume (darwin 25.6.0)

| mount | the holder's folder after xattr -w, cp -p and ditto | xattr -w | mdutil -s | tmutil isexcluded |
| :- | :- | :- | :- | :- |
| default | ._a.txt, ._b-cp.txt, ._b-ditto.txt, a.txt, b-cp.txt, b-ditto.txt | ok | /System/Volumes/Data/Users/runner/work/_temp/s6/nfs-tree: Indexing and searching disabled. | [Excluded] /Users/runner/work/_temp/s6/nfs-tree |
| nouserxattr | ._a.txt, ._b-cp.txt, ._b-ditto.txt, a.txt, b-cp.txt, b-ditto.txt | ok | /System/Volumes/Data/Users/runner/work/_temp/s6/nfs-tree: Indexing and searching disabled. | [Excluded] /Users/runner/work/_temp/s6/nfs-tree |
| noappledouble | ._a.txt, ._b-cp.txt, ._b-ditto.txt, a.txt, b-cp.txt, b-ditto.txt | ok | /System/Volumes/Data/Users/runner/work/_temp/s6/nfs-tree: Indexing and searching disabled. | [Excluded] /Users/runner/work/_temp/s6/nfs-tree |

DSDontWriteNetworkStores: FAILED: 2026-11-05 10:03:41.329 defaults[16878:48866] The domain/default pair of (com.appl

#### volume: macos27-nfs-volume (darwin 27.0.0)

| mount | the holder's folder after xattr -w, cp -p and ditto | xattr -w | mdutil -s | tmutil isexcluded |
| :- | :- | :- | :- | :- |
| default | ._a.txt, ._b-cp.txt, ._b-ditto.txt, a.txt, b-cp.txt, b-ditto.txt | ok | /System/Volumes/Data/Users/runner/work/_temp/s6/nfs-tree: Indexing and searching disabled. | [Excluded] /Users/runner/work/_temp/s6/nfs-tree |
| nouserxattr | ._a.txt, ._b-cp.txt, ._b-ditto.txt, a.txt, b-cp.txt, b-ditto.txt | ok | /System/Volumes/Data/Users/runner/work/_temp/s6/nfs-tree: Indexing and searching disabled. | [Excluded] /Users/runner/work/_temp/s6/nfs-tree |
| noappledouble | ._a.txt, ._b-cp.txt, ._b-ditto.txt, a.txt, b-cp.txt, b-ditto.txt | ok | /System/Volumes/Data/Users/runner/work/_temp/s6/nfs-tree: Indexing and searching disabled. | [Excluded] /Users/runner/work/_temp/s6/nfs-tree |

DSDontWriteNetworkStores: FAILED: Error: Domain 'com.apple.desktopservices' not found.

#### coherence: linux-coherence (linux 7.0.0-1019-azure)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| plain | correct: 46 'B' | stale: 46 bytes {"C":46} | correct: 46 'B' | 1008 ms | stale: 46 bytes {"C":46} | 1010 ms | 1009 ms | 1009 ms |
| cached | correct: 46 'B' | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 26 ms | stale: 46 bytes {"C":46} | 26 ms | 26 ms | 26 ms |

home/<this computer>: {"target":"/home/runner/work/_temp/s6","entries":4}

#### coherence: macos26-fskit-macfuse-5.4.0-coherence (darwin 25.6.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| plain | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"C":200} | never (10 s) | never (10 s) | (never seen) |
| cached | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"A":200} | never (10 s) | never (10 s) | (never seen) |

home/<this computer>: {"target":"/Users/runner/work/_temp/s6","entries":4}

#### coherence: macos26-fskit-macfuse-5.5.0-coherence (darwin 25.6.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| plain | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"C":200} | never (10 s) | never (10 s) | (never seen) |
| cached | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"A":200} | never (10 s) | never (10 s) | (never seen) |

home/<this computer>: {"target":"/Users/runner/work/_temp/s6","entries":4}

#### coherence: macos26-nfs-ac1-coherence (darwin 25.6.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs cached, actimeo=1 | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 767 ms | stale: 46 bytes {"C":46} | 1007 ms | 997 ms | 991 ms |

#### coherence: macos26-nfs-coherence (darwin 25.6.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs plain | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 1160 ms | stale: 46 bytes {"C":46} | 1000 ms | 2005 ms | 1992 ms |

#### coherence: macos26-nfs-files0-dirs1-coherence (darwin 25.6.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 33 ms | stale: 46 bytes {"C":46} | 62 ms | 32 ms | 69 ms |

#### coherence: macos26-nfs-noac-coherence (darwin 25.6.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs cached, noac | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 30 ms | stale: 46 bytes {"C":46} | 59 ms | 56 ms | 29 ms |

#### coherence: macos27-fskit-macfuse-5.4.0-coherence (darwin 27.0.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| plain | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"C":200} | never (10 s) | never (10 s) | (never seen) |
| cached | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"A":200} | never (10 s) | never (10 s) | (never seen) |

home/<this computer>: {"target":"/Users/runner/work/_temp/s6","entries":4}

#### coherence: macos27-fskit-macfuse-5.5.0-coherence (darwin 27.0.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| plain | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"C":200} | never (10 s) | never (10 s) | (never seen) |
| cached | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | never (10 s) | stale: 200 bytes {"A":200} | never (10 s) | never (10 s) | (never seen) |

home/<this computer>: {"target":"/Users/runner/work/_temp/s6","entries":4}

#### coherence: macos27-nfs-ac1-coherence (darwin 27.0.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs cached, actimeo=1 | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 985 ms | stale: 46 bytes {"C":46} | 1011 ms | 992 ms | 982 ms |

#### coherence: macos27-nfs-coherence (darwin 27.0.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs plain | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 1383 ms | stale: 46 bytes {"C":46} | 2001 ms | never (10 s) | (never seen) |

#### coherence: macos27-nfs-files0-dirs1-coherence (darwin 27.0.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs cached, acregmin=0,acregmax=0,acdirmin=0,acdirmax=1 | WRONG: 46 'B' then 154 bytes the holder never sent | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 33 ms | stale: 46 bytes {"C":46} | 66 ms | 35 ms | 59 ms |

#### coherence: macos27-nfs-noac-coherence (darwin 27.0.0)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| nfs cached, noac | correct: 46 'B' | stale: 46 bytes {"C":46} | old version: 200 'A' (stale, but bytes the holder sent) | 30 ms | stale: 46 bytes {"C":46} | 61 ms | 30 ms | 57 ms |

#### coherence: windows-coherence (win32 10.0.26100)

| mount | shrinks after a stat | grows after a stat | shrinks after a read | size seen after | grows after a read | grown content seen after | new name seen after | delete seen after |
| :- | :- | :- | :- | -: | :- | -: | -: | -: |
| plain | correct: 46 'B' | correct: 300 'C' | correct: 46 'B' | 1001 ms | correct: 300 'C' | 3 ms | 1031 ms | 1016 ms |
| cached | correct: 46 'B' | correct: 300 'C' | correct: 46 'B' | 38 ms | correct: 300 'C' | 2 ms | 35 ms | 33 ms |

home/<this computer>: {"error":"ENOENT: ENOENT: no such file or directory, scandir 'T:\\home\\Runner'"}
