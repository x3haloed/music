# Resident operations

Music keeps source development, installed runtime bytes, and a resident's life
in three different places. On this machine the prepared layout is:

```text
/Users/chad/Repos/music/                         development and tests
/Users/chad/.local/share/music/installations/   immutable releases
/Users/chad/.local/share/music/residents/        resident habitats
/Users/chad/.local/share/music/backups/          habitat snapshots
```

An installed release is a detached, physically independent Git clone at
`installations/releases/COMMIT`. `installations/current` is only a convenience
pointer to the newest verified installation. A long-running resident must be
started from the exact release directory, not through `current`, so installing
or testing later Music code cannot silently change what runs after a restart.

## Install a release

The installer refuses a dirty development checkout or a commit that has not
been pushed to its configured upstream. It clones without local hardlinks,
installs locked dependencies, runs the complete check suite and external doctor,
and only then changes `current` atomically.

```sh
cd /Users/chad/Repos/music
node bin/music-install-release.js /Users/chad/.local/share/music/installations
```

Keep the exact `release` path printed by the command. That is the executable
path to use for hatch and residence.

## Create, then hatch

Creating a habitat makes only empty private directories and a GLM Flash model
configuration. It does not create an identity or ledger.

```sh
/Users/chad/.local/share/music/installations/releases/COMMIT/bin/music-habitat.js \
  create /Users/chad/.local/share/music/residents/RESIDENT
```

Hatch is the separate, deliberate act. Run it once from the exact pinned
release. The final path segment `RESIDENT` is only an operator-facing habitat
label; it is not presented to the subject as a personal name:

```sh
/Users/chad/.local/share/music/installations/releases/COMMIT/bin/music-habitat.js \
  init /Users/chad/.local/share/music/residents/RESIDENT
```

`init` refuses any habitat that already has a ledger. It creates a stable opaque
subject identity with no personal designation. No model call occurs during
either command.

Keep the OpenRouter key outside the repository and habitat, readable only by
the operating-system account. The existing location on this machine is
`/Users/chad/.config/music/openrouter.env`. After loading it into the supervisor
environment, start the resident from the same exact release:

```sh
set -a
source /Users/chad/.config/music/openrouter.env
set +a
/Users/chad/.local/share/music/installations/releases/COMMIT/bin/music-habitat.js \
  reside /Users/chad/.local/share/music/residents/RESIDENT
```

The habitat wrapper fixes the resident home, ledger, mailbox, dependency root,
and model configuration. Music changes its process working directory to the
resident home before exposing ordinary tools. Every process start appends its
exact Git commit, release path, event format, clean-tree status and digest,
Node/platform identity, mode, and resident home to the subject ledger before
opening another encounter.

## Snapshot and upgrade

Never initialize or run inference against a copy of the real resident ledger.
Disposable rehearsals must begin from their own fresh `music-habitat create`
and `init`. Read-only audit of the real ledger is allowed.

For a snapshot or upgrade:

1. Stop the resident gracefully and wait for process exit.
2. Snapshot the complete habitat with the currently pinned release.
3. Install and verify the new release from the development checkout.
4. Use the new exact release to run `music-habitat audit` against the stopped
   habitat. This must reconstruct the complete existing ledger without writes.
5. If the audit reports a format-10 or format-11 ledger and the new release
   requires current developmental geometry, run the explicit migration once.
   It archives the exact old bytes inside `state/lineage/`; it does not rewrite
   them into approximate current events.
6. Audit again and verify the same subject, tool digests, carrier root, recorded
   lineage head/digest/count, retained tool-version count, pending contact and
   unresolved-consequence counts, and a valid current position.
7. Start residence from that new exact release path.

```sh
/Users/chad/.local/share/music/installations/releases/OLD_COMMIT/bin/music-habitat.js \
  snapshot /Users/chad/.local/share/music/residents/RESIDENT \
  /Users/chad/.local/share/music/backups

/Users/chad/.local/share/music/installations/releases/NEW_COMMIT/bin/music-habitat.js \
  audit /Users/chad/.local/share/music/residents/RESIDENT

/Users/chad/.local/share/music/installations/releases/NEW_COMMIT/bin/music-habitat.js \
  migrate /Users/chad/.local/share/music/residents/RESIDENT

/Users/chad/.local/share/music/installations/releases/NEW_COMMIT/bin/music-habitat.js \
  audit /Users/chad/.local/share/music/residents/RESIDENT
```

Snapshots acquire the ledger writer lease and therefore refuse to race a live
resident. Each snapshot contains a SHA-256 inventory. It excludes the transient
writer lock and lives outside the habitat, preventing recursive copies.

Keep the previous release. To switch back, stop gracefully and first prove that
the old release can audit the current ledger. If it cannot, do not overwrite the
resident with an old snapshot: preserve all bytes and fix forward or perform an
explicit, separately reviewed migration.

## Recovery boundaries

- `music-doctor check RELEASE` compares the installed continuity core with the
  release's own committed `HEAD`.
- `music-doctor restore RELEASE` is explicit and preserves divergent bytes
  before restoring them.
- A syntactically torn final ledger append can be recovered with a retained
  receipt; a complete digest-invalid event is refused unchanged.
- The development checkout, `current`, disposable habitats, and test artifacts
  are never service paths for the long-term resident.

## Election-addressed contact

Normal `music reply` remains the preferred response to a visible message: when
that message's invocation fulfilled a trajectory election, Music derives the
election ancestry automatically. An adapter or operator with a retained election
id can instead address the choice itself:

```sh
node /Users/chad/.local/share/music/installations/releases/COMMIT/src/cli.js \
  reply-election /Users/chad/.local/share/music/residents/RESIDENT/mailbox \
  ELECTION_ID Chad "This observation bears on the election itself."
```

The reference supplies provenance only. It does not tell the resident what the
observation means or require a machinery change.
