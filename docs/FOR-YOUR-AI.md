# Briefing for the AI that will install your copy

Goal: install this Mission Control with the accounts, agents and workspace of the
owner of this copy. Start by reading README.md and docs/INSTALL.md.

1. Inspect only the owner's environment; confirm the OpenClaw version and how the
   dashboard can reach its Gateway (docs/INSTALL.md, section 2).
2. Compare that OpenClaw version with docs/OPENCLAW.md. If it is not 2026.9.x,
   check that the methods and parameters listed there still exist, using read-only
   calls, before enabling any write, chat or administrative control.
3. Ask the owner whether to connect a workspace, and in which language: that decides
   the folder and field names (docs/WORKSPACE.md) and `MC_WORKSPACE_LAYOUT`. Ask
   too which interface language they prefer as the default (`language` in
   public/brand.js).
4. Run the demo and the tests with fictional data.
5. Customize public/brand.js and fill in .env without printing secrets.
6. Choose the sign-in mode with the owner (docs/INSTALL.md, section 3); never use
   `none` for a dashboard other devices can reach.
7. Start it, then approve only the dashboard's own device in OpenClaw, checking the
   device ID shown on the Home page.
8. Validate every route without login before giving the address to anyone.
9. Test the controls with disposable data and record what was actually verified.

Never reuse accounts, access emails, domains, tokens or credentials from another installation.
Do not assume the Gateway contract is the same in a different version.
Do not use the demo as a production server.
Do not copy real data into this repository to run tests.
Report failures with the exact message observed, and preserve existing data.

Before deploying for customers or offering a paid service, read LICENSE and
COMMERCIAL.md and confirm that a written commercial agreement exists. Personal
and internal use by the owner is free, including in companies.
