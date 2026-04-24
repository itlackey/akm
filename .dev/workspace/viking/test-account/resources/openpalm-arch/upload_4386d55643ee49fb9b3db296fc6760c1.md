# OpenPalm Architecture

OpenPalm is a self-hosted AI assistant platform. It uses Docker Compose for orchestration, Caddy as a reverse proxy, and includes an admin panel, guardian service, and OpenCode AI runtime.

The guardian service handles HMAC verification, replay detection, and rate limiting for all channel traffic.

Key components:
- Admin: SvelteKit app for operator UI and API
- Guardian: Bun HTTP server for security
- Assistant: OpenCode runtime with tools and skills
- Channels: Protocol adapters (Discord, API, etc.)
