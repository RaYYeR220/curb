# IMD protected suites

`Hook.protected.t.sol`, `Owners.protected.t.sol` and `Token.protected.t.sol` are IMD's admission
floor for `univ4_hook` launches, served at `GET https://api.imd.fun/reads/suite/univ4_hook`. They
are copied unchanged except for their import paths. `support/` holds local stand-ins for the
verifier's harness files, which the suite imports but IMD does not publish.

Run them against the exact creation code a launch would deploy with `bash script/protected.sh`.
They are excluded from the default `forge test` because they need the `IMD_*` environment.
