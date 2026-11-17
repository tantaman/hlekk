# Deploy a Hlekk database

These examples run the same [wiki Worker](./wiki/wiki-app.ts) on [Cloudflare Durable Objects](#cloudflare-durable-objects), [Rivet](#rivet), or [celld](#celld). Each starts with its own empty database. A directory object tracks which SQLite host owns each shard, and KV holds the published shard map. The sample creates two pages on a two-host deployment and reads the link between them.

## Set up

From the repository root, use Node.js 24 and install the locked dependencies. Choose one example directory and run the remaining commands from there.

```sh
npm ci
cd examples/cloudflare  # or examples/rivet or examples/celld
```

Create the example's operator token once. The Worker uses it for initialization and writes. Reads are public. Keep this file for subsequent runs.

```sh
(umask 077; set -C; printf 'HLEKK_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars)
```

### Cloudflare Durable Objects

Start Wrangler locally. It keeps the database in `.wrangler/state`.

```sh
npx wrangler dev --port 8787
```

To deploy, sign in to your Cloudflare account. Wrangler provisions the two SQLite-backed Durable Object classes and the KV namespace declared in this example. The deployment name defaults to `hlekk-example`. [Wrangler resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)

```sh
npx wrangler login
npx wrangler deploy --secrets-file .dev.vars
```

Use the printed Worker URL for the [graph check](#write-and-read-the-graph).

### Rivet

Rivet's OpenOrange CLI runs each Hlekk host and the directory as Rivet Actors. It also supplies the KV binding. Install the CLI and run it from `examples/rivet`. Local state lives in `.open-orange/`. [OpenOrange quickstart](https://openorange.dev/docs/)

```sh
npm install -g open-orange@1.0.3
orange dev --port 8787
```

To deploy, start Docker and use a Rivet Cloud cluster for the example. Replace `YOUR_CLUSTER` with its name. The pool serves the URL printed by the deploy command. [Rivet deployment guide](https://openorange.dev/docs/deploy/)

```sh
orange login
orange link --cluster YOUR_CLUSTER
orange deploy --pool hlekk-example --secrets-file .dev.vars
```

### celld

Install celld 0.6.2 for your platform. Put the checkout's esbuild on your path, then start a node and local object store. Run these commands from `examples/celld`. Local state lives in `.celld/dev/`. [celld installation and local development](https://celld.dev/docs/#install)

```sh
export PATH="$PWD/../../node_modules/.bin:$PATH"
celld dev --port 8787
```

To deploy to a single node backed by Amazon S3, choose an existing private bucket and a fresh prefix for this example. Set the AWS region and supply bucket credentials through the AWS credential chain on both the deployment machine and the node. celld stores the deployment configuration, including the operator token, in that bucket. The helper passes the token through a temporary owner-readable file because `celld deploy` reads Worker variables from its configuration. [celld storage and deployment](https://celld.dev/docs/#configure-object-storage)

```sh
export AWS_REGION=us-east-1
export CELLD_BUCKET=s3://YOUR-BUCKET/hlekk-example
node --env-file=.dev.vars deploy.mjs
```

On the node, set the same `CELLD_BUCKET` and region, then run the following command. The Worker listens on loopback. Run the graph check there or forward port 8080 over SSH. For a fleet, give each node a private peer listener and advertised address. [celld node configuration](https://celld.dev/docs/#start-a-node)

```sh
celld --listen 127.0.0.1:8080
```

## Write and read the graph

In a second terminal in the same example directory, set `BASE` to the local address below, the deployed HTTPS URL, or `http://127.0.0.1:8080` for the bucket-backed celld node.

```sh
BASE=http://127.0.0.1:8787
node --env-file=.dev.vars ../seed.mjs "$BASE"
curl -fsS "$BASE/page?title=Hlekk"
curl -fsS "$BASE/db"
```

The seed command initializes the directory, upserts the pages and edges, and checks that the page titled `Hlekk` links to `SQLite`. The first curl returns the graph under `page.links.items`. The second returns the Hlekk protocol descriptor. Restart the local server and repeat the first curl to read the saved edge. You can also run the seed again against the same example database.

To check the deployed read protocol, run the repository's conformance suite from the example directory.

```sh
node ../../scripts/conformance.mjs "$BASE/db"
```

For a deployment that other databases will link to, set `vars.HLEKK_DATABASE_URI` in its Wrangler config to its stable HTTPS URL ending in `/db` before initializing it.
