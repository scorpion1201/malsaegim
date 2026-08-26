# syntax=docker/dockerfile:1
# 말새김 — three-stage build: Rust → wasm, Next.js standalone build, minimal runtime.
# Secrets (.env) are never baked into the image; pass them at run time with --env-file or -e.

# ---------- 1) Audio splitter wasm (Rust, alpine/musl to match the Node images) ----------
FROM rust:1.98-alpine AS wasm
# build-base: C toolchain for native deps of wasm-pack; binaryen: wasm-opt on musl
RUN apk add --no-cache build-base binaryen \
 && rustup target add wasm32-unknown-unknown \
 && cargo install wasm-pack --version 0.15.0 --locked
WORKDIR /build
COPY Cargo.toml ./
COPY crates ./crates
# Prebuilt wasm-bindgen/binaryen downloads are glibc binaries and cannot run on musl:
# build the wasm-bindgen CLI at the exact version the crate resolves to (wasm-opt comes from apk)
RUN cargo generate-lockfile \
 && V=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p') \
 && cargo install wasm-bindgen-cli --version "$V" --locked
RUN wasm-pack build crates/audio-splitter --target web --release --out-dir /build/pkg

# ---------- 2) Next.js build ----------
FROM node:26-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
# Node 25+ images no longer ship corepack; install it to honor package.json's yarn@4.18.0
RUN npm i -g corepack@latest && corepack enable && corepack prepare yarn@4.18.0 --activate
WORKDIR /app
COPY package.json .yarnrc.yml ./
RUN yarn install
COPY tsconfig.json next.config.ts ./
COPY src ./src
COPY public ./public
COPY --from=wasm /build/pkg ./src/app/_lib/audio/pkg
# package.json's `build` rebuilds the wasm (no cargo here), so run next build directly
RUN yarn next build

# ---------- 3) Runtime ----------
FROM node:26-alpine AS server
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

    # Run as malsaegim (uid 501) in group admin (gid 80); reuse the group if the base image already has gid 80
RUN (grep -q ':80:' /etc/group || addgroup -g 80 admin) \
 && adduser -u 501 -G "$(getent group 80 | cut -d: -f1)" -D -H -s /sbin/nologin malsaegim

 WORKDIR /app

# standalone output contains server.js and only the traced node_modules (incl. @rhwp/core wasm)
COPY --from=build --chown=malsaegim:admin /app/.next/standalone ./
COPY --from=build --chown=malsaegim:admin /app/.next/static ./.next/static
# Standalone output does not include public/ — copy it next to server.js
COPY --from=build --chown=malsaegim:admin /app/public ./public

USER malsaegim

CMD ["node", "server"]

EXPOSE 3000