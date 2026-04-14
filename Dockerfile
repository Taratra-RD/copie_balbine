FROM debian:bullseye-slim

# Install Asterisk + utils
RUN apt-get update && apt-get install -y --no-install-recommends \
    asterisk \
    && rm -rf /var/lib/apt/lists/*

# Crée les dossiers pour le montage
RUN mkdir -p /var/lib/asterisk /var/log/asterisk

# Expose ports
EXPOSE 5060/udp 5060/tcp 5000/tcp 10000-10100/udp

# Lance Asterisk au démarrage sans Stasis
CMD ["asterisk", "-f", "-vvv", "-n", "-C", "/etc/asterisk/asterisk.conf"]
