# syntax=docker/dockerfile:1
# 말새김 — Rust → wasm, 모델 받기(고정 리비전·sha256) · wasm 런타임(emscripten) · manifest, Next.js standalone build, minimal runtime.
# Secrets (.env) are never baked into the image; pass them at run time with --env-file or -e.

# WITH_MODELS=0 이면 모델·wasm 을 만들지 않는다 (public/models 가 비어 On-Device 는 "서버에 모델이 없습니다")
ARG WITH_MODELS=1

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

# ---------- 2) whisper 모델: whisper.cpp 공식 ggml 배포본을 고정 리비전으로 받아 sha256 검증 ----------
FROM alpine:3.22 AS fetch
ARG WITH_MODELS
RUN apk add --no-cache curl coreutils
WORKDIR /build
COPY scripts/models/versions.sh scripts/models/fetch-whisper-models.sh ./scripts/models/
RUN mkdir -p /out && if [ "$WITH_MODELS" = "1" ]; then WORK=/build/work sh scripts/models/fetch-whisper-models.sh /out && rm -rf /build/work; fi

# ---------- 3) 엔진 wasm (emscripten + Rust): xtask 가 whisper.cpp 를 클론해 CPU·WebGPU 런타임 두 벌을 만든다 ----------
# WebGPU 런타임은 emscripten 의 emdawnwebgpu 포트를 쓴다 (빌드 중 GitHub 릴리스에서 받는다)
FROM emscripten/emsdk:4.0.23 AS emsdk
ARG WITH_MODELS
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git cmake \
 && rm -rf /var/lib/apt/lists/*
# Rust nightly + emscripten 타깃 + rust-src(build-std) — 엔진 래퍼는 Rust 이고 최종 링크는 emcc 가 한다
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly --profile minimal \
 && /root/.cargo/bin/rustup component add rust-src \
 && /root/.cargo/bin/rustup target add wasm32-unknown-emscripten
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /build
COPY Cargo.toml ./
COPY crates ./crates
# xtask: whisper.cpp 클론 → malsaegim-engine.{js,wasm}(CPU) + malsaegim-engine-webgpu.{js,wasm}(WebGPU)
RUN mkdir -p /out && if [ "$WITH_MODELS" = "1" ]; then \
      cargo run -p malsaegim-engine --bin xtask --release -- /out /build/work \
   && rm -rf /build/work target; fi

# ---------- 4) manifest: 해시·크기 계산, 버전 디렉터리로 정리 ----------
FROM node:26-alpine AS manifest
ARG WITH_MODELS
WORKDIR /build
COPY scripts/models/write-manifest.mjs ./
COPY --from=fetch /out ./src
COPY --from=emsdk /out ./src
RUN mkdir -p /out && if [ "$WITH_MODELS" = "1" ]; then node write-manifest.mjs ./src /out; fi

# ---------- 5) models: `docker build --target models -o public/models .` 로 로컬에 꺼내 쓰는 스테이지 ----------
FROM scratch AS models
COPY --from=manifest /out /

# ---------- 6) Next.js build ----------
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
# 모델·wasm 은 이미지 안에서 만든 것만 쓴다 (.dockerignore 가 로컬 public/models 를 뺀다)
COPY --from=manifest /out ./public/models
COPY --from=wasm /build/pkg ./src/app/_lib/audio/pkg
# 공유 링크(Open Graph)에 쓰는 주소 — 메타데이터는 빌드 때 고정된다
ARG NEXT_PUBLIC_SITE_URL
# package.json's `build` rebuilds the wasm (no cargo here), so run next build directly
RUN yarn next build

# ---------- 7) Runtime ----------
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