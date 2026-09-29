# Security Policy

## Supported versions

Only the latest release gets security fixes.

## Reporting a vulnerability

Please **don't** open a public issue for security problems.

Report them privately through GitHub: go to the repo's **Security** tab → **Report a vulnerability**
([direct link](https://github.com/payandeh/doppel/security/advisories/new)).

Include what an attacker could do, the steps to reproduce it, and the Chrome and Doppel versions. You should get a reply
within a week. Once a fix is released, you'll be credited in the advisory unless you'd rather not be.

## Scope

Doppel runs a script in every page to intercept `fetch` and `XMLHttpRequest`. Issues we especially want to hear about:

- A web page reading overrides it shouldn't see (overrides are meant to stay in the extension's isolated world).
- A web page changing or injecting overrides.
- Anything that makes Doppel change requests or responses when no override matches.
