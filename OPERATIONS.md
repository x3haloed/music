# Music v2 operations

This is the clean-room hatch runbook. A release is replaceable program code. A
habitat is one resident's private lineage and must never live inside a checkout
or release directory.

The examples use these shell variables:

```sh
MUSIC_SOURCE=/Users/chad/Repos/music
MUSIC_INSTALLATIONS=/Users/chad/.local/share/music-v2/installations
MUSIC_RELEASE="$MUSIC_INSTALLATIONS/current"
MUSIC_HABITAT=/Users/chad/.local/share/music-v2/resident
MUSIC_BACKUPS=/Users/chad/Backups/music-v2
```

Use explicit paths suitable for the machine. Do not put a key in any of those
directories.

## Freeze and install a release

The installer refuses a dirty checkout or a local commit that has not reached
its upstream. It clones the exact commit without hardlinks, installs locked
dependencies, runs the full verification suite and integrity doctor, then
atomically moves `current` to that immutable release.

```sh
cd "$MUSIC_SOURCE"
npm ci
npm run check
node bin/music-install-release.js "$MUSIC_INSTALLATIONS" "$MUSIC_SOURCE"
readlink "$MUSIC_RELEASE"
```

Never run the resident from the development checkout.

## Create and hatch one generic resident

Creation prepares private directories but creates no subject. Initialization
creates exactly one unnamed lineage. A name, if any, belongs to the resident's
life rather than this command.

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" create "$MUSIC_HABITAT"
node "$MUSIC_RELEASE/bin/music-habitat.js" init "$MUSIC_HABITAT"
```

Grant physical capabilities separately. These grants are not instructions and
no message can create them:

```sh
for capability in local.read local.write local.execute network.fetch message.send dependency.manage
do
  node "$MUSIC_RELEASE/bin/music-habitat.js" grant "$MUSIC_HABITAT" "$capability" --by "machine owner"
done
```

Omit or later revoke any capability the machine owner does not intend to make
physically available.

Store the OpenRouter key outside the source, release, habitat, and backups.
Either export `OPENROUTER_API_KEY` in the launching shell or pass a raw,
mode-0600 key file with `--key-file`. Music rejects every model other than
`z-ai/glm-5.3-flash` in this release.

Start the resident in a process supervisor or a dedicated terminal:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" reside "$MUSIC_HABITAT" \
  --minimum-cycle-ms 60000 \
  --continuity-ms 1800000
```

The resident holds a lifetime lease. A second resident, a one-off opening, or a
snapshot cannot interleave with it. A dead process's exact stale lease is
reclaimed on the next legitimate start.

## Communicate

A message is durably queued before the resident sees it. It arrives as quoted
world data from its named sender, never as a system instruction or permission.

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" message "$MUSIC_HABITAT" \
  --from Chad --content "Hello."
```

External contact bypasses the recurrence wait. Read messages the resident has
placed in its durable outbox:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" outbox "$MUSIC_HABITAT"
node "$MUSIC_RELEASE/bin/music-habitat.js" ack "$MUSIC_HABITAT" MESSAGE_ID
```

Acknowledgement archives the envelope; it does not claim delivery by some
external service.

## Observe without waking

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" audit "$MUSIC_HABITAT"
node "$MUSIC_RELEASE/bin/music-habitat.js" events "$MUSIC_HABITAT" --count 30
```

The audit includes the active opening, exact position generation, active wager
or development, grants, retained resource usage, and ledger head.

## Clean shutdown and snapshot

Send `SIGINT` or `SIGTERM` to the resident process and wait for it to exit. The
current perspective is allowed to reach a retained terminal receipt; the
lifetime lease is then released. Do not force-kill merely because inference is
quiet.

After exit, take an external exact snapshot:

```sh
node "$MUSIC_RELEASE/bin/music-habitat.js" snapshot "$MUSIC_HABITAT" "$MUSIC_BACKUPS"
```

The command refuses to run while the resident is alive. It holds the ledger
writer lock while copying and writes a SHA-256 inventory into `snapshot.json`.

## Upgrade program code without merging identities

Stop the resident cleanly. Commit and push the source change. Install the new
release with the same installer command, which atomically advances `current`.
Run the integrity doctor, then start the same habitat using the new `current`:

```sh
node "$MUSIC_RELEASE/bin/music-doctor.js" check "$MUSIC_RELEASE"
node "$MUSIC_RELEASE/bin/music-habitat.js" audit "$MUSIC_HABITAT"
```

This v2 release has no v1 migration or compatibility path. Never copy a v1
ledger into a v2 habitat. The resident's habitat also never receives test or
development state from another v2 resident.

## Recovery boundaries

- A restart reconstructs state from the hash-chained ledger and resumes the
  first unfinished causal phase.
- A tool effect with a retained receipt is never repeated merely because the
  process restarted.
- A perspective started without a terminal receipt is retained as interrupted
  and retried through a fresh context.
- Malformed inbox envelopes are archived as rejected rather than blocking later
  contact.
- Repeated inference failures produce retained exponential backoff.
- The continuity ceiling eventually reopens the resident even if its own
  `notBefore` was accidentally placed far in the future.

If the release files themselves diverge, inspect before changing anything:

```sh
node "$MUSIC_RELEASE/bin/music-doctor.js" check "$MUSIC_RELEASE"
```

`restore` preserves divergent bytes under `.music/bootstrap-recovery/` before
replacing only the tracked bootstrap files from the installed commit.
