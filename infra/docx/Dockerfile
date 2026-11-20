# Build only: the resulting rootfs is mounted read-only in the existing Worker.
# No daemon, networked converter service, document, or credential is in this image.
FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS runtime
ENV DEBIAN_FRONTEND=noninteractive
ARG DEBIAN_MIRROR=https://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=https://deb.debian.org/debian-security
RUN sed -i "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g; s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install --yes --no-install-recommends \
    libreoffice-writer bubblewrap fontconfig fonts-noto-cjk fonts-noto-core fonts-noto-extra fonts-noto-color-emoji \
    fonts-liberation2 fonts-crosextra-carlito python3 \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY fonts.conf /etc/fonts/local.conf
COPY run-converter.py probe.py /opt/p2-docx/
COPY bwrap /opt/p2-docx/bwrap
COPY build-manifest.py /opt/p2-docx/build-manifest.py
RUN chmod 0555 /opt/p2-docx/bwrap && fc-cache -f \
    && mkdir -p /work /input /out /proc /dev \
    && python3 /opt/p2-docx/build-manifest.py /manifest.json
# Export a directory using docker build --output; it is not a running service.
FROM scratch AS bundle
COPY --from=runtime / /rootfs/
COPY --from=runtime /manifest.json /manifest.json
