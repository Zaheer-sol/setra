# setra-exec-sidecar

Reads Monad execution events from a node's event ring (official SDK, `release/exec-events-sdk-v1.1`)
and forwards payment signals for wallets Setra monitors. Design, evidence and limits:
[`docs/execution-events.md`](../../docs/execution-events.md).

## Build

```bash
./scripts/fetch-sdk.sh                 # shallow clone of the SDK tag into vendor/monad
cargo build --release
cargo test                             # tracker + filter unit tests
```

Linux: `sudo apt install gcc g++ cmake clang-19 libzstd-dev libhugetlbfs-dev`.
macOS (snapshots only): Xcode 16.3+, `brew install cmake zstd`; if Homebrew is not in a standard
prefix, export `CPATH`, `LIBRARY_PATH` and `BINDGEN_EXTRA_CLANG_ARGS=-I<prefix>/include`.

## Run

```bash
# live, on the node host
SETRA_URL=https://api.example.com SETRA_EXEC_EVENTS_TOKEN=… \
  setra-exec-sidecar --chain-id 143 --event-ring-path /var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events

# replay a snapshot and print signals
setra-exec-sidecar --event-ring-path ./testdata/exec-events-emn-30b-15m.zst --token <erc20> --all-recipients --stdout

# check the replay against a canonical RPC node
node scripts/validate-snapshot.mjs out.ndjson <rpc-url> <erc20> <fromBlock> <toBlock>
```

Snapshots: `curl -L https://raw.githubusercontent.com/category-labs/monad/refs/tags/release/exec-events-sdk-v1.1/rust/crates/monad-exec-events/test/data/exec-events-emn-30b-15m/snapshot.zst -o testdata/exec-events-emn-30b-15m.zst`

Exit codes: `0` finished (snapshot), `1` could not open the ring (includes the SDK's schema check),
`2` the node is on a different chain than `--chain-id`, `3` Setra rejected a batch (token, chain or
data): a configuration error that retrying will not fix.

## systemd

```ini
[Unit]
Description=Setra execution events sidecar
After=monad-execution.service
Requires=monad-execution.service

[Service]
User=monad
Environment=SETRA_URL=https://api.example.com
EnvironmentFile=/etc/setra/sidecar.env          # SETRA_EXEC_EVENTS_TOKEN=…
ExecStart=/usr/local/bin/setra-exec-sidecar --chain-id 143 \
  --event-ring-path /var/lib/hugetlbfs/user/monad/pagesize-2MB/event-rings/monad-exec-events
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Logs are JSON lines on stderr (`sidecar_started`, `watchlist_loaded`, `execution_event_gap`,
`execution_events_stalled`, `delivery_failed`, `rejected_by_setra`).
