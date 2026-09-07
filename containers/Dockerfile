FROM node@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

LABEL org.opencontainers.image.title="Engineering Governance"
WORKDIR /opt/engineering-governance

# checkout and the governance change detector both require git in the job container.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY . /opt/engineering-governance

# Keep the image usable for GitHub container-job steps. An ENTRYPOINT would prepend
# itself to every step command and turn `governance check` into script arguments.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'exec node /opt/engineering-governance/scripts/governance.mjs "$@"' \
    > /usr/local/bin/governance \
    && chmod 0755 /usr/local/bin/governance

CMD ["governance", "check"]
