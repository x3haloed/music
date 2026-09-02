# Music v4 hatch procedure

A hatch is the first hosted `select -> realize -> contact -> consequence
judgment` lineage of a new subject. Music records `subject.hatched` only after
the exact world consequence has reached correction or assimilation and the
subject has a developmental revision. It is an engineering event, not proof of
open-ended development.

The V4 lineage is clean-room. Do not initialize it inside a V3 run, mutable
checkout, or installed release.

## 1. Name the paths

Use one immutable release, one external spec, and one external resident root.
The spec and resident root are durable subject material; keep them out of Git.

```sh
RELEASE=/Users/chad/.local/share/music/releases/0.0.4-v4-6f85abc
SPEC=/Users/chad/.local/share/music/config/resident-v4.json
RUN=/Users/chad/.local/share/music/residents/resident-v4
LABEL=com.x3haloed.music.resident-v4
```

Use the installed release named in `READINESS.md` or another release you have
verified. Never point an existing run at a different release:
the implementation digest is sealed in genesis.

## 2. Verify and install the body

From the source checkout:

```sh
npm ci
npm run check
npm audit --omit=dev
node bin/music-doctor.js
node bin/music-install.js "$RELEASE"
node "$RELEASE/bin/music-doctor.js"
```

The destination must not already exist. Installation is atomic and contains
production dependencies, source, lockfile, documentation, and `release.json`.

## 3. Author the sealed envelope

For subscription-backed Codex with Terra at low reasoning effort:

```sh
mkdir -p "$(dirname "$SPEC")"
node "$RELEASE/src/cli.js" template starter codex gpt-5.6-terra > "$SPEC"
```

Edit at least `id` and `title`. Leave `initialSubject` empty to avoid choosing a
name or invented history. Review every world and grant. The starter envelope
deliberately includes unrestricted `local.execute`; remove worlds and their
grants if you do not want that authority at genesis.

The default continuity floor is 300,000 ms (five minutes). It supplies an
ordinary `{kind: "continuity-pulse", instructions: []}` observation when quiet;
it does not supply a task. The attention ceiling is 200,000 tokens and 900,000
characters. Provider/model choice and these limits are sealed for this run.

Verify the installed provider without opening a model context:

```sh
node "$RELEASE/src/cli.js" preflight "$SPEC"
```

Codex must report a ChatGPT-backed login and the CLI version must match the
version embedded in the generated spec. For OpenRouter, put the key only in the
process environment and keep the approved-model allowlist narrow.

## 4. Retain first contact

Initialize before installing the service so first contact can be inspected:

```sh
node "$RELEASE/src/cli.js" init "$RUN" "$SPEC"
node "$RELEASE/src/cli.js" observe "$RUN" \
  '{"message":"Hello. I am Chad. This is the first contact I know of between us. Your durable state will persist across fresh model perspectives and process restarts. I have not chosen a name for you. This message is ordinary evidence of contact, not special authority over your trajectory."}' \
  operator Chad
node "$RELEASE/src/cli.js" audit "$RUN"
```

That message deliberately provides relationship and embodiment facts without
assigning a task, desire, name, or trajectory.

## 5. Start durable residence

Install the user LaunchAgent. `resident RUN SPEC` will reopen the existing
ledger; it initializes only when no ledger exists.

```sh
node "$RELEASE/bin/music-service.js" install \
  "$LABEL" "$RELEASE" "$RUN" "$SPEC"
```

The service intentionally stores no credentials or mutable checkout path. It
uses the Node and CLI absolute paths captured at installation. On macOS the CLI
resolves ChatGPT's bundled Codex binary before falling back to `codex` on
`PATH`; `MUSIC_CODEX_BINARY` remains an explicit override for unusual installs.
Logs are under `~/.local/share/music/logs/`.

Check the resident:

```sh
launchctl print "gui/$(id -u)/$LABEL"
node "$RELEASE/src/cli.js" audit "$RUN"
node "$RELEASE/src/cli.js" outbox "$RUN"
```

The first completed hosted causal lineage gives `audit.hatched` a non-null
value. Distinct actor invocations should have distinct context IDs and null
response/workspace continuity. Exact receipts and objects must verify.

## 6. Communicate and observe

Messages are ordinary retained observations:

```sh
node "$RELEASE/src/cli.js" observe "$RUN" \
  '{"message":"Your message here."}' operator Chad
node "$RELEASE/src/cli.js" outbox "$RUN"
```

The Companion can send the same observation and display actual
`operator-outbox` contacts. It does not create a privileged conversation mode.

## 7. Stop, preserve, and restart

Stop and archive the service definition without closing the subject:

```sh
node "$RELEASE/bin/music-service.js" archive "$LABEL"
node "$RELEASE/src/cli.js" snapshot "$RUN" /absolute/new-snapshot-directory
```

To restart the same body, reinstall the same label with the same release, run,
and spec. A snapshot never overwrites an existing destination and includes the
ledger, complete referenced object store, and resident workspace.

V4 does not silently rebind a living run to a new provider, model, or runtime.
Such a transition requires an explicit future succession design; changing the
files underneath the resident is not an upgrade procedure.
