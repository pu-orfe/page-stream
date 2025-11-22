# Managing Secret Stream IDs

## Problem

Docker Compose's `.env` file parser treats `#` as a comment character, which causes issues with Kaltura SRT stream IDs that contain `#` (e.g., `streamid=#:::e=1_abc123,st=0,p=xyz456`). When these stream IDs are stored in `.env`, everything after the `#` is stripped as a comment.

## Solution

Use a shell script (`.env.secrets.sh`) to export environment variables directly, bypassing the `.env` file parser:

### Setup

1. Create `.env.secrets.sh` (already gitignored):

```bash
#!/bin/bash
# Source this file before running docker-compose to load secret stream IDs
# Usage: source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

export STANDARD_1_INGEST='srt://host:port?streamid=#:::e=1_stream1,st=0,p=pass1'
export STANDARD_2_INGEST='srt://host:port?streamid=#:::e=1_stream2,st=0,p=pass2'
export STANDARD_3_INGEST='srt://host:port?streamid=#:::e=1_stream3,st=0,p=pass3'
export STANDARD_4_INGEST='srt://host:port?streamid=#:::e=1_stream4,st=0,p=pass4'
export COMPOSITOR_INGEST='srt://host:port?streamid=#:::e=1_composite,st=0,p=pass5'
```

2. Make it executable:
```bash
chmod +x .env.secrets.sh
```

### Usage

Always source the secrets file before running docker-compose commands:

```bash
# Start all services
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml up -d

# Restart services
source .env.secrets.sh && docker-compose -f docker-compose.stable.yml restart

# Stop services (no secrets needed)
docker-compose -f docker-compose.stable.yml down
```

### Important Notes

- **`.env.secrets.sh` is gitignored** - your secrets stay local
- **Single quotes preserve `#` characters** - the shell won't treat them as comments
- **Array command syntax required** - docker-compose.stable.yml uses array syntax for commands to avoid shell expansion issues
- **Always source before compose** - environment variables must be set before docker-compose reads them

### Security

- Never commit `.env.secrets.sh` to version control
- The file is already added to `.gitignore`
- Store backups securely (password manager, encrypted storage, etc.)
- Use different stream IDs for development and production environments

### Troubleshooting

If containers show `streamid=` (empty):
1. Verify you sourced `.env.secrets.sh` before running docker-compose
2. Check that variables are exported: `echo $STANDARD_1_INGEST`
3. Verify the compose file uses array command syntax (not string)

If stream IDs are truncated after `#`:
- You're likely using `.env` file directly (which won't work)
- Switch to using `.env.secrets.sh` with the `source` command
