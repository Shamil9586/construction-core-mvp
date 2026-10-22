# R04 CP-02 — Review-only Git bundle input

**Purpose:** temporary input storage for the **independent** R04 PostgreSQL/Chromium acceptance workflow. This branch is **NOT** a release and must **NOT** be merged into `main`.

## Required single uploaded binary

Filename: `R04_CP02_candidate.bundle`

Expected SHA-256: `7a22bf6ded4e70536a3bcbbfd949c23873ce894e2574245a197b7a3978396821`

Git head inside bundle: `b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d`

Expected tree: `2f5d3648b330c30642a08b62e7737834dbe25ec2`

Parent chain: `92fcf6d047fd22453349260432dbc65590386a17` -> `e7ddcf63900e3a6d9f8d69d4815d54dfacc07260` -> `169ae902fafaf0f836464b2741af4bf98afd6a3b` -> `b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d`.

To supply it through GitHub UI: navigate to **this branch**, select **Add file → Upload files**, upload only `R04_CP02_candidate.bundle` from the owner-approved evidence packet, and commit only to **this branch**. Do not create a PR for this branch.

The CI workflow verifies the bundle's SHA-256 and exact Git candidate/tree/parents before executing any tests, and will refuse to run if it is missing or different.

No PostgreSQL credentials, Claude OAuth values, Render keys, LIVE URLs, or other secrets belong in this branch.

This repo is currently public; uploaded contents will be visible publicly. Only the owner-approved candidate code bundle, not private deployment credentials or test evidence containing secrets, should be uploaded.

The branch can be retired after R04 acceptance; subsequent GPR-2 candidates may use a separately permitted review branch, while the reusable CI scripts stay on `main`.
