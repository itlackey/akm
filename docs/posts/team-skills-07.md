---
title: "Your Team's Agent Skills Are a Mess. Here's How to Fix It."
cover_image: 'https://raw.githubusercontent.com/itlackey/akm/main/docs/posts/akm-logo-sized.webp'
series: akm
description: Every agent skills article is about individual developers. But teams are where skills become valuable and messy simultaneously.
tags:
  - ai
  - agents
  - cli
  - skills
published: false
---

Alice has a deploy skill in Claude Code. Bob has one in Cursor. Carol wrote hers for Codex. All three do slightly different things — Alice's includes the canary step, Bob's skips it, Carol's adds a Slack notification that the other two don't know about.

When the deploy process changes — say, the team adds a new staging environment — Alice updates her skill. She mentions it in standup. Bob says he'll update his later. Carol doesn't hear about it because she was out that day. Two weeks later, Bob deploys to the wrong environment because his skill still has the old configuration.

This isn't hypothetical. If your team uses AI coding assistants, this is happening right now. Every developer building up their own skill collection, no shared source of truth, no way to know when someone else has a better version of the same thing.

Every agent skills article on the internet is written for individual developers. But teams are where skills become both most valuable and most chaotic. Here's how to fix it.

## Option 1: Shared Filesystem

The simplest approach. Your team already has a shared drive or mounted directory. Use it.

```sh
# Team lead creates the shared source
mkdir -p /mnt/shared/team-skills/skills/deploy
cat > /mnt/shared/team-skills/skills/deploy/SKILL.md << 'EOF'
# Deploy to Production

Standard deployment workflow for all services.

## Steps
1. Run test suite: `bun test`
2. Build: `bun run build`
3. Deploy to staging: `./scripts/deploy.sh staging`
4. Run smoke tests: `./scripts/smoke.sh staging`
5. Deploy to production: `./scripts/deploy.sh production`
6. Notify #deploys channel in Slack

## Rollback
If smoke tests fail: `./scripts/rollback.sh staging`
EOF
```

Each developer adds it as a source:

```sh
akm add /mnt/shared/team-skills
akm search "deploy"
```

That's it. The shared skill appears in everyone's search results alongside their personal skills. When the team lead updates the deploy skill, everyone sees the update on the next index refresh. No copying. No syncing. No "hey, I updated the deploy skill" messages in Slack.

The shared filesystem approach works best for co-located teams or teams that already share infrastructure. It's zero-overhead to set up and requires no additional services.

## Option 2: Git-Hosted Team Skills

For distributed teams, a Git repository is the natural choice. You already use Git for everything else. Why not for skills?

```sh
# Team lead creates the repo
# github.com/your-org/team-agent-skills
# Standard kit structure: skills/, commands/, knowledge/

# Each developer adds it
akm add github:your-org/team-agent-skills

# Pull latest when needed
akm update --all
```

This buys you everything Git provides:

- **Version history.** See when the deploy skill changed and why.
- **Pull request review.** New skills and updates go through the same review process as code.
- **Branch-based testing.** Try a new version of a skill on a branch before merging.
- **CI integration.** Lint your skill files, validate structure, run tests.

The Git approach also means your team skills are portable. A new developer clones the repo (via `akm add`), and they have the entire team's skill library indexed and searchable immediately. No onboarding doc that says "copy these files to these directories."

## Option 3: Private Registry

For larger teams or organizations that want discoverability without mandating specific skills, akm supports private registries.

A registry is a searchable index of available skills. Developers browse it, find what they need, and install selectively. Think npm for agent skills, but hosted internally.

```sh
# Search the team registry
akm search "deploy" --registry https://registry.internal.company.com

# Install a specific skill from the registry
akm add registry:deploy-to-k8s
```

The registry approach works best when:

- Your organization has dozens of teams, each with their own skills
- You want teams to discover each other's work without requiring everyone to index everything
- You need access control (some skills are sensitive — deployment credentials, internal API patterns)

## The Customization Bridge: Clone

Here's the scenario that every team hits: the standard deploy skill works for 90% of cases. But your project has a specific environment variable, an extra pre-deploy step, or a different notification channel.

You don't want to modify the team skill — that would break it for everyone else. You don't want to write your own from scratch — that's the duplication problem we started with.

`akm clone` solves this:

```sh
# Fork the team skill into your personal source
akm clone skill:deploy

# Now you have a local copy to customize
# Edit ~/.akm/sources/default/skills/deploy/SKILL.md
# Add your project-specific steps
```

The team version stays clean. Your fork is yours to customize. Both appear in your search results — the team version and your customized version — with the local fork ranked higher since it's in your personal source.

When the team updates their version (say, adding that new staging environment), you can re-clone to get the update, then reapply your customizations. Or diff the two versions to see what changed.

## Putting It Together

Here's what the full workflow looks like for a team of five:

**Team lead (one-time setup):**
```sh
# Create the team skills repo
mkdir team-agent-skills
cd team-agent-skills
akm setup
# Add skills, commands, knowledge
# Push to github.com/your-org/team-agent-skills
```

**Each developer (one-time setup):**
```sh
# Add team source alongside personal sources
akm add github:your-org/team-agent-skills
akm add ~/.claude/skills
akm add ~/.codex/skills
```

**Daily workflow:**
```sh
# Search finds results from all sources
akm search "deploy"

# Team skill and personal skills appear together
# Best match wins, regardless of source

# Pull team updates
akm update --all
```

**When customization is needed:**
```sh
akm clone skill:deploy
# Edit local copy
# Both versions stay searchable
```

No file copying. No sync scripts. No "which version is correct?" conversations. The team source is the source of truth. Personal forks are explicitly personal. Search finds everything.

## The Progressive Disclosure Advantage

This workflow is built on the progressive disclosure pattern I covered in the [previous post](https://dev.to/itlackey). At team scale, it's not just an optimization — it's a necessity.

A team of five, each with 30 personal skills plus 50 shared team skills, has 200 total skills in play. Front-loading all of them into every agent session would cost 200,000+ tokens. With akm's search-then-load pattern, each session uses only the 2-5 skills it actually needs.

The agent doesn't know or care whether a skill came from the team source, a personal directory, or a Git repository. It searches, it finds, it loads. The source management is your concern as a developer. The skill content is the agent's concern. Clean separation.

## Getting Started

If you're a team lead looking to set up shared skills:

1. Pick your approach: shared filesystem for co-located teams, Git repo for distributed teams, registry for large organizations
2. Create the shared source with a standard [kit structure](https://github.com/itlackey/akm/blob/main/docs/getting-started.md)
3. Have each developer run `akm add` to register the source
4. Start with 3-5 high-value skills that everyone uses (deploy, test, review, etc.)
5. Iterate from there

The infrastructure is minimal. The payoff is immediate.

- [akm on GitHub](https://github.com/itlackey/akm)
- [Getting Started guide](https://github.com/itlackey/akm/blob/main/docs/getting-started.md)
- [Registry documentation](https://github.com/itlackey/akm/blob/main/docs/registry.md)
- [Part 1: Your AI Agent's Skill List Is Getting Out of Hand](https://dev.to/itlackey/your-ai-agents-skill-list-is-getting-out-of-hand-32ck)
- [Part 2: You Already Have Dozens of Agent Skills](https://dev.to/itlackey/you-already-have-dozens-of-agent-skills-you-just-cant-find-them-bpo)
