# syntax=docker/dockerfile:1.7
#
# NatsuRoute in one image. The data is built inside the image:
#
#   docker build \
#     --secret id=odpt_api_key,env=ODPT_API_KEY \
#     --secret id=odpt_challenge_token,env=ODPT_CHALLENGE_TOKEN \
#     -t natsuroute .
#   docker run -p 8787:8787 -e CONTACT_EMAIL=you@example.com \
#     -e ODPT_API_KEY -e ODPT_CHALLENGE_TOKEN natsuroute
#
# The geo stage (PLATEAU buildings for 23 wards, the Kanto OpenStreetMap
# extract, Hokonavi, cooling shelters) takes 30-60 minutes the first time and
# is cached afterwards. ODPT keys are build secrets, never image layers; the
# raw downloads are deleted, and only the built files are kept. The server
# needs about 1.2 GB of memory.

FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- geo layers
FROM python:3.12-slim-bookworm AS geo
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY geo/requirements.txt geo/requirements.txt
RUN pip install --no-cache-dir -r geo/requirements.txt
COPY geo geo
RUN mkdir -p data/raw/osm \
 && (curl -fsSL -o data/raw/osm/kanto.osm.pbf https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf \
     || curl -fsSL -o data/raw/osm/kanto.osm.pbf https://download.openstreetmap.fr/extracts/asia/japan/kanto.osm.pbf) \
 && JOBS=4 python3 geo/plateau.py \
 && python3 geo/osm.py data/raw/osm/kanto.osm.pbf \
 && python3 geo/hokonavi.py \
 && python3 geo/shelters.py \
 && python3 geo/pack.py \
 && rm -rf data/raw geo/out

# ---------------------------------------------------------------- timetables
FROM base AS data
COPY tsconfig.json ./
COPY pipeline pipeline
COPY src src
COPY --from=geo /app/data/build/geo data/build/geo
RUN --mount=type=secret,id=odpt_api_key,required=true \
    --mount=type=secret,id=odpt_challenge_token,required=true \
    ODPT_API_KEY="$(cat /run/secrets/odpt_api_key)" \
    ODPT_CHALLENGE_TOKEN="$(cat /run/secrets/odpt_challenge_token)" \
    npm run data:fetch \
 && NODE_OPTIONS=--max-old-space-size=6144 npm run data:build \
 && npm run data:replay \
 && rm -rf data/raw

# ---------------------------------------------------------------- web app and server bundle
FROM base AS web
COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=web /app/dist dist
COPY --from=data /app/data/build data/build
USER node
EXPOSE 8787
CMD ["node", "--max-old-space-size=1800", "dist/server.mjs"]
