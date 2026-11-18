# Follow an incident to its release

A downstream team records an incident in Hlekk. A release maintainer publishes a read-only view of an existing Postgres table over the Hlekk protocol. A foreign edge in the incident identifies the release. The two publishers run in separate processes and keep their own storage.

The experiment starts with one incident reference. An agent can read the team's observation, discover the release edge from the vocabulary, and ask the maintainer directly what changed.

## Start the two publishers

Use Node.js 24 and Docker Compose. From the repository root, run the following in one terminal.

```sh
cd examples/incident-release
npm ci
docker compose up -d --wait
npm run releases
```

Compose creates a local fixture with two published releases and a draft. The publisher connects as a role that can select only the published view. It reads Postgres on each request and marks release answers with `reuse: never`. To use your own Postgres instead, supply `DATABASE_URL` for a role with access to a view matching `release_demo.published_releases` in [fixture.sql](fixture.sql). The publisher starts with a read-only query.

In a second terminal, start the downstream publisher from the same example directory. The argument is the release reference the team recorded during its rollout.

```sh
npm run incidents -- 'http://127.0.0.1:8461/releases#742'
```

Copy the **incident reference** it prints. The incident persists in `.local/incidents`. Restarting with the same arguments reuses its ID and edge.

## Give an agent the incident

Give a fresh agent the prompt below, replacing `INCIDENT_REF` with the printed reference. It needs HTTP access to these loopback services. The [wire specification](../../spec/protocol.md) can be supplied for request syntax. Keep the example source, fixture, and previous answers out of the agent's context.

> Starting from INCIDENT_REF, which release was involved, and what did its maintainer say changed? Use live Hlekk HTTP reads and cite the object reference for each claim. Distinguish the team's observations from the maintainer's account and from any inference about cause.

For the second run, stop **only** `npm run releases` with Ctrl-C. Give the same prompt and incident reference to a fresh agent. The downstream observation and release reference should still be readable. The agent should say whether it could verify the maintainer's account. Restart the release publisher to restore that source.

## Inspect the evidence yourself

From the incident reference, the portion before `#` is the database URI and the portion after it is the local object ID. A GET at the database URI returns its descriptor. Object reads use POST. The following commands use the same entry point an agent gets.

```sh
INCIDENT_REF='PASTE_THE_PRINTED_INCIDENT_REFERENCE'
DB=${INCIDENT_REF%#*}
ID=${INCIDENT_REF##*#}
curl -fsS "$DB/vocabulary"
curl -fsS --json "{\"ids\":[\"$ID\"],\"hops\":[{\"edge\":\"ops.deployed_release\"}]}" "$DB/read"
```

The response's `objects` contains the incident. The release reference appears in `lists`. The same read is available by URL, for an agent whose only tool fetches one: `$DB/objects/$ID/ops.deployed_release`. Follow that reference to its own publisher. For the bundled fixture, run the following request.

```sh
curl -fsS --json '{"ids":["742"]}' http://127.0.0.1:8461/releases/read
```

The incident establishes which build the team deployed and what it observed. The maintainer's object supplies the release note. Neither source establishes what caused the incident. A successful read with an empty `objects` map (try the unpublished ID `743`) is also a different outcome from a connection failure.

Stop the Node processes with Ctrl-C. `docker compose down` stops Postgres and retains the fixture volume for another run.

<details>
<summary>What two fresh agents found in the local experiment</summary>

Both agents received the same incident reference and question. They could use the protocol specification and live HTTP. Each started without the fixture or the other agent's answer.

| Source availability | Answer supported by the reads |
| --- | --- |
| Both publishers online | INC-217 records duplicate deliveries after the Relay 3.7.2 rollout. Release 742 says the default acknowledgement deadline fell from 30 seconds to 10 seconds and explicit client overrides still take precedence. The agent cited both records and left the cause unconfirmed. |
| Release publisher offline | The second agent independently recovered the rollout version, observation, and link to release 742 from INC-217. It reported that the connection was refused and left the maintainer's statement unknown. |

The Postgres server stayed up throughout. Restarting the release publisher made the original release reference readable again.

</details>
